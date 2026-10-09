// The per-thread MCP config file (`thread-<terminalId>.mcp.json`, beside the MCP config path):
// every spawn writes it, and a thread that is gone takes its file with it.
//
// A delete path: every test works in a NESTED dir (TMPDIR/dispatch-thread-mcp-XXXX/nested/mcp)
// and checks only paths inside its own dir, so a wrong delete cannot reach anything else.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/connection.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { SessionService } from './service.js';

const PREFIX = 'dispatch-thread-mcp-';

/** A PTY manager stub: records spawns; `failSpawn` makes the next spawns throw. */
class FakePty extends EventEmitter {
  alive = new Set<string>();
  failSpawn = false;
  isAlive(id: string) { return this.alive.has(id); }
  kill(id: string) { this.alive.delete(id); }
  spawn(id: string) {
    if (this.failSpawn) throw new Error('spawn failed');
    this.alive.add(id);
    return 1234;
  }
  setDefaultEnv() {}
}

let outer: string | undefined;
let mcpDir: string;
let db: Database.Database;
let pty: FakePty;
let svc: SessionService;

const configFile = (id: string) => path.join(mcpDir, `thread-${id}.mcp.json`);
const threadFiles = () => fs.readdirSync(mcpDir).filter((f) => /^thread-.*\.mcp\.json$/.test(f));
function plant(file: string) {
  // Only ever inside this test's own dir.
  expect(file.startsWith(outer! + path.sep)).toBe(true);
  fs.writeFileSync(file, '{"mcpServers":{}}');
}
function seed(id: string, sessionId = 's1', externalId?: string) {
  terminalsDb.create(db, { id, sessionId, type: 'claude-code', label: id, workingDir: path.join(outer!, 'proj'), externalId });
}

beforeEach(() => {
  outer = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  mcpDir = path.join(outer, 'nested', 'mcp');
  fs.mkdirSync(mcpDir, { recursive: true });
  fs.mkdirSync(path.join(outer, 'proj'));
  db = createDatabase(path.join(outer, 'test.db'));
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'proj', workingDir: path.join(outer, 'proj') });
  sessionsDb.create(db, { id: 's2', provider: 'claude-code', name: 'other', workingDir: path.join(outer, 'proj') });
  pty = new FakePty();
  svc = new SessionService(db, pty as any, path.join(mcpDir, 'mcp.json'));
});
afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  // Remove only this test's own dir: a PREFIX dir directly inside the TMPDIR.
  if (outer && path.dirname(outer) === path.resolve(os.tmpdir()) && path.basename(outer).startsWith(PREFIX)) {
    fs.rmSync(outer, { recursive: true, force: true });
  }
  outer = undefined;
});

describe('the per-thread MCP config file', () => {
  it('a deleted (archived) thread loses its file; the other files stay', () => {
    seed('t1');
    seed('t2');
    plant(configFile('t1'));
    plant(configFile('t2'));
    plant(path.join(mcpDir, 'mcp.json'));
    plant(path.join(outer!, 'nested', 'thread-t1.mcp.json')); // same name, another dir

    svc.removeTerminal('t1');

    expect(fs.existsSync(configFile('t1'))).toBe(false);
    expect(fs.existsSync(configFile('t2'))).toBe(true);
    expect(fs.existsSync(path.join(mcpDir, 'mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(outer!, 'nested', 'thread-t1.mcp.json'))).toBe(true);
  });

  it('a restored thread gets its file back: every spawn writes it again', () => {
    seed('t1', 's1', 'ext-1');
    svc.relaunchTerminal('t1');
    expect(fs.existsSync(configFile('t1'))).toBe(true);

    svc.removeTerminal('t1');
    expect(fs.existsSync(configFile('t1'))).toBe(false);

    svc.restoreTerminal('t1');
    expect(terminalsDb.getById(db, 't1')?.status).not.toBe('error');
    const cfg = JSON.parse(fs.readFileSync(configFile('t1'), 'utf8'));
    expect(Object.keys(cfg.mcpServers)).toContain('dispatch');
  });

  it('a deleted project loses the files of all its threads, archived ones too; another project keeps its own', () => {
    seed('t1');
    seed('t2');
    terminalsDb.archive(db, 't2');
    seed('t3', 's2');
    for (const id of ['t1', 't2', 't3']) plant(configFile(id));

    svc.archive('s1');

    expect(terminalsDb.getById(db, 't1')).toBeNull();
    expect(fs.existsSync(configFile('t1'))).toBe(false);
    expect(fs.existsSync(configFile('t2'))).toBe(false);
    expect(fs.existsSync(configFile('t3'))).toBe(true);
  });

  it('a thread whose spawn fails is removed with its file', () => {
    seed('t0', 's1', 'ext-0'); // the branch source
    pty.failSpawn = true;
    expect(() => svc.createTerminal('s1', 'claude-code')).toThrow(/spawn failed/);
    expect(() => svc.createRunnerTerminal('s1', 'claude-code', undefined, undefined, 'say hi')).toThrow(/spawn failed/);
    expect(() => svc.branchTerminal('t0')).toThrow(/spawn failed/);
    expect(threadFiles()).toEqual([]);
  });

  it('a thread without a file deletes cleanly', () => {
    seed('t1');
    expect(() => svc.removeTerminal('t1')).not.toThrow();
    expect(terminalsDb.getById(db, 't1')?.archived_at).toBeTruthy();
  });

  it('an id with a path separator or ".." deletes nothing', () => {
    // Where each id would lead without the check, all inside this test's own dir.
    const targets = [
      path.join(outer!, 'nested', 'x.mcp.json'), // 'a/../../x'
      path.join(mcpDir, 'thread-a\\b.mcp.json'), // 'a\\b' (a file name on POSIX)
      path.join(mcpDir, 'thread-...mcp.json'), // '..'
      path.join(mcpDir, 'thread-.mcp.json'), // ''
    ];
    for (const t of targets) plant(t);
    for (const id of ['a/../../x', 'a\\b', '..', '']) (svc as any).removeThreadMcpConfig(id);
    for (const t of targets) expect(fs.existsSync(t), t).toBe(true);
  });
});
