// W3-B characterization: how SessionService resolves a file path of a thread and types a file
// reference into its CLI, recorded through the facade before the code moved to ThreadFiles. The
// facade must do the same after the move.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { SessionService } from '../../src/sessions/service.js';

class FakePty extends EventEmitter {
  alive = new Set<string>();
  written: [string, string][] = [];
  isAlive(id: string) { return this.alive.has(id); }
  write(id: string, data: string) { this.written.push([id, data]); }
}

let tmp: string;
let db: Database.Database;
let pty: FakePty;
let svc: SessionService;
const proj = () => path.join(tmp, 'proj');
const wt = () => path.join(tmp, 'proj', '.claude', 'worktrees', 'w');

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-fileref-char-')));
  fs.mkdirSync(wt(), { recursive: true });
  fs.writeFileSync(path.join(proj(), 'in-project.md'), 'x');
  fs.writeFileSync(path.join(wt(), 'only-in-worktree.md'), 'x');
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: proj() });
  terminalsDb.create(db, { id: 't', sessionId: 's1', type: 'claude-code', label: 't', workingDir: wt() });
  terminalsDb.create(db, { id: 'p', sessionId: 's1', type: 'claude-code', label: 'p' });
  pty = new FakePty();
  svc = new SessionService(db, pty as any, path.join(tmp, 'mcp.json'));
});
afterEach(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('SessionService resolveTerminalFilePath (characterization)', () => {
  it('a relative path: the project copy when it exists, else the thread folder; the inbox is always the project one', () => {
    expect(svc.resolveTerminalFilePath('t', 'in-project.md')).toBe(path.join(proj(), 'in-project.md'));
    expect(svc.resolveTerminalFilePath('t', 'only-in-worktree.md')).toBe(path.join(wt(), 'only-in-worktree.md'));
    expect(svc.resolveTerminalFilePath('t', 'new.md')).toBe(path.join(wt(), 'new.md'));
    expect(svc.resolveTerminalFilePath('t', '.dispatch/inbox/a.png')).toBe(path.join(proj(), '.dispatch', 'inbox', 'a.png'));
    expect(svc.resolveTerminalFilePath('p', 'new.md')).toBe(path.join(proj(), 'new.md'));
  });

  it('an absolute path inside the project or the thread folder is kept; outside it is refused', () => {
    expect(svc.resolveTerminalFilePath('t', path.join(wt(), 'a.md'))).toBe(path.join(wt(), 'a.md'));
    expect(svc.resolveTerminalFilePath('t', path.join(proj(), 'b.md'))).toBe(path.join(proj(), 'b.md'));
    expect(() => svc.resolveTerminalFilePath('t', '/etc/passwd')).toThrow('Path traversal not allowed');
    expect(() => svc.resolveTerminalFilePath('t', '../outside.md')).toThrow('Path traversal not allowed');
  });

  it('an unknown thread: null', () => {
    expect(svc.resolveTerminalFilePath('missing', 'a.md')).toBeNull();
  });
});

describe('SessionService sendFileReference (characterization)', () => {
  it('agent-context types a line with a carriage return; shell-path types the quoted path and a space', () => {
    pty.alive.add('p');
    expect(svc.sendFileReference('p', 'in-project.md')).toEqual({ sentText: `Use this file as context: ${path.join(proj(), 'in-project.md')}\r` });
    expect(svc.sendFileReference('p', "it's.md", 'shell-path')).toEqual({ sentText: `'${path.join(proj(), "it'\\''s.md")}' ` });
    expect(pty.written.map(([id]) => id)).toEqual(['p', 'p']);
  });

  it('a dead CLI throws; an unknown thread and a path with a control character answer null and type nothing', () => {
    expect(() => svc.sendFileReference('p', 'in-project.md')).toThrow('Terminal process is not running');
    pty.alive.add('p');
    expect(svc.sendFileReference('missing', 'a.md')).toBeNull();
    expect(svc.sendFileReference('p', 'a\rb.md')).toBeNull();
    expect(pty.written).toEqual([]);
  });
});
