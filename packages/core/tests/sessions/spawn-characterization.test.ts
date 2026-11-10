// W3-B characterization: how SessionService starts a thread, recorded through the facade before the
// code moved to ThreadSpawner. The facade must do the same after the move.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as appState from '../../src/db/app-state.js';
import { SessionService } from '../../src/sessions/service.js';
import { KeyRegistry } from '../../src/auth/principals.js';

class FakePty extends EventEmitter {
  alive = new Set<string>();
  spawns: { id: string; command: string; args: string[]; cwd: string; env?: Record<string, string> }[] = [];
  failNext: Error | null = null;
  isAlive(id: string) { return this.alive.has(id); }
  kill(id: string) { this.alive.delete(id); }
  killAll() { this.alive.clear(); }
  write() {}
  spawn(id: string, command: string, args: string[], cwd: string, env?: Record<string, string>) {
    if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
    this.spawns.push({ id, command, args, cwd, env }); this.alive.add(id); return 700 + this.spawns.length;
  }
  setDefaultEnv() {}
}

class FakeStructured extends EventEmitter {
  live = new Set<string>();
  spawns: { id: string; opts: any }[] = [];
  sent: [string, unknown, unknown][] = [];
  failNext: Error | null = null;
  setDefaultEnv() {}
  spawn(id: string, opts: any) {
    if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
    this.spawns.push({ id, opts }); this.live.add(id); return 900 + this.spawns.length;
  }
  sendMessage(id: string, content: unknown, source: unknown) { this.sent.push([id, content, source]); }
  answerPermission() { return false; }
  setEscalate() { return true; }
  interrupt() { return true; }
  compact() {}
  noteDeclaredStatus() {}
  getPending() { return null; }
  getSessionId() { return undefined; }
  getEvents() { return []; }
  getEventsTail() { return []; }
  getTurnTexts(): string[] | null { return null; }
  isAlive(id: string) { return this.live.has(id); }
  kill(id: string) { this.live.delete(id); this.emit('exit', id, 0); }
  killAll() { this.live.clear(); }
}

let tmp: string;
let db: Database.Database;
let pty: FakePty;
let mgr: FakeStructured;
let svc: SessionService;
let reg: KeyRegistry;
const savedCap = process.env.DISPATCH_MAX_LIVE_THREADS;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-spawn-char-'));
  fs.mkdirSync(path.join(tmp, 'proj'));
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: path.join(tmp, 'proj') });
  pty = new FakePty();
  mgr = new FakeStructured();
  reg = new KeyRegistry();
  svc = new SessionService(db, pty as any, path.join(tmp, 'data', 'mcp.json'));
  svc.setKeyRegistry(reg, { keyDir: path.join(tmp, 'keys') });
  svc.setDaemonApi('http://127.0.0.1:41999');
  svc.registerStructuredManager('claude-code', mgr as any);
});
afterEach(() => {
  if (savedCap === undefined) delete process.env.DISPATCH_MAX_LIVE_THREADS; else process.env.DISPATCH_MAX_LIVE_THREADS = savedCap;
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('SessionService spawn (characterization)', () => {
  it('a CLI thread: one PTY spawn in the project folder, its own MCP config file, the pid saved, the terminal id and one key in the env', () => {
    const t = svc.createTerminal('s1', 'claude-code', 'cli');
    expect(pty.spawns.length).toBe(1);
    const s = pty.spawns[0];
    expect(s.id).toBe(t.id);
    expect(s.cwd).toBe(path.join(tmp, 'proj'));
    expect(s.env?.DISPATCH_TERMINAL_ID).toBe(t.id);
    expect(s.env?.DISPATCH_AUTH).toMatch(/^dtk_/);
    const file = path.join(tmp, 'data', `thread-${t.id}.mcp.json`);
    expect(fs.existsSync(file)).toBe(true);
    expect(s.args.join(' ')).toContain(file);
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers)).toEqual(['dispatch']);
    expect(terminalsDb.getById(db, t.id)!.pid).toBe(701);
    expect(mgr.spawns).toEqual([]);
    expect((t.config as Record<string, unknown>).spawnDepth).toBe(0);
  });

  it('a structured spawn writes the MCP config and mints one key', () => {
    const before = reg.size();
    const t = svc.createTerminal('s1', 'claude-code', 'pretty', undefined, undefined, undefined, { transport: 'structured' });
    expect(mgr.spawns.length).toBe(1);
    expect(pty.spawns).toEqual([]);
    const o = mgr.spawns[0].opts;
    expect(o.env.DISPATCH_AUTH).toMatch(/^dtk_/);
    expect(o.env.DISPATCH_TERMINAL_ID).toBe(t.id);
    expect(o.cwd ?? o.workDir).toBe(path.join(tmp, 'proj'));
    expect(fs.existsSync(path.join(tmp, 'data', `thread-${t.id}.mcp.json`))).toBe(true);
    expect(reg.size() - before).toBe(1);
    expect((svc.getTerminal(t.id)!.config as Record<string, any>).toolsAvailable).toBeUndefined(); // no plugin system wired
  });

  it('a spawn that fails removes the new row and its MCP config file, revokes its key, and names the thread in the error', () => {
    const before = reg.size();
    pty.failNext = new Error('spawn ENOENT');
    expect(() => svc.createTerminal('s1', 'claude-code', 'broken')).toThrow(/^Failed to start broken: /);
    expect(svc.listTerminals('s1')).toEqual([]);
    expect(fs.readdirSync(path.join(tmp, 'data')).filter((f) => f.startsWith('thread-'))).toEqual([]);
    expect(reg.size()).toBe(before);
  });

  it('a spawn with no room in the project throws the cap error', () => {
    process.env.DISPATCH_MAX_LIVE_THREADS = '1';
    svc.createTerminal('s1', 'claude-code', 'one');
    expect(svc.liveThreadCount('s1')).toBe(1);
    expect(() => svc.createTerminal('s1', 'claude-code', 'two')).toThrow('This project already has 1 live threads (the limit is 1). Archive or stop some, or raise DISPATCH_MAX_LIVE_THREADS.');
    expect(svc.listTerminals('s1').length).toBe(1);
  });

  it('ensureStructuredAlive: starts a dead Pretty thread once; answers false for a CLI thread, a queued thread, an archived thread and a missing thread', () => {
    terminalsDb.create(db, { id: 'p', sessionId: 's1', type: 'claude-code', label: 'p', config: { transport: 'structured' } });
    terminalsDb.create(db, { id: 'c', sessionId: 's1', type: 'claude-code', label: 'c' });
    terminalsDb.create(db, { id: 'q', sessionId: 's1', type: 'claude-code', label: 'q', config: { transport: 'structured', queued: true } });
    terminalsDb.create(db, { id: 'sh', sessionId: 's1', type: 'shell', label: 'sh' });
    expect(svc.ensureStructuredAlive('p')).toBe(true);
    expect(svc.ensureStructuredAlive('p')).toBe(true);
    expect(mgr.spawns.map((s) => s.id)).toEqual(['p']);
    expect(svc.ensureStructuredAlive('c')).toBe(false);
    expect(svc.ensureStructuredAlive('q')).toBe(false);
    expect(svc.ensureStructuredAlive('sh')).toBe(false);
    expect(svc.ensureStructuredAlive('missing')).toBe(false);
    terminalsDb.archive(db, 'p');
    mgr.live.delete('p');
    expect(svc.ensureStructuredAlive('p')).toBe(false);
  });

  it('a Pretty thread that cannot start: the send names the cause', () => {
    terminalsDb.create(db, { id: 'p', sessionId: 's1', type: 'claude-code', label: 'p', config: { transport: 'structured' } });
    mgr.failNext = new Error('claude is not installed');
    expect(svc.ensureStructuredAlive('p')).toBe(false);
    mgr.failNext = new Error('claude is not installed'); // the send tries one start of its own
    expect(() => svc.sendStructuredMessage('p', 'hello')).toThrow('could not start the thread: claude is not installed');
  });

  it('a queued thread has no process until it starts; the start spawns it, clears the markers and sends the parked task', () => {
    const q = svc.createQueuedTerminal('s1', 'claude-code', 'later', { transport: 'structured', role: 'agent' }, 'do the task');
    expect(mgr.spawns).toEqual([]);
    expect(q.status).toBe('queued');
    const started = svc.startQueuedTerminal(q.id)!;
    expect(mgr.spawns.map((s) => s.id)).toEqual([q.id]);
    expect(mgr.sent).toEqual([[q.id, 'do the task', 'coordinator']]);
    const cfg = started.config as Record<string, unknown>;
    expect('queued' in cfg || 'queuedTask' in cfg).toBe(false);
    expect(started.status).toBe('waiting');
    expect(svc.startQueuedTerminal('missing')).toBeNull();
  });

  it('a coordinator is refused on the CLI transport', () => {
    expect(() => svc.createTerminal('s1', 'claude-code', 'co', undefined, undefined, undefined, { role: 'coordinator' })).toThrow(/without a governed coordinator-capable structured transport/);
  });

  it('removing a thread stops its process, revokes its key, archives the row and removes its MCP config file; a restore starts it again', () => {
    const t = svc.createTerminal('s1', 'claude-code', 'cli');
    const file = path.join(tmp, 'data', `thread-${t.id}.mcp.json`);
    const withKey = reg.size();
    svc.removeTerminal(t.id);
    expect(pty.alive.has(t.id)).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    expect(reg.size()).toBe(withKey - 1);
    expect(svc.listArchivedTerminals('s1').map((x) => x.id)).toEqual([t.id]);
    svc.restoreTerminal(t.id);
    expect(pty.spawns.length).toBe(2);
    expect(fs.existsSync(file)).toBe(true);
    expect(svc.listTerminals('s1').map((x) => x.id)).toEqual([t.id]);
  });

  it('a thread made with a folder of its own remembers that folder as the last folder (the base behaviour)', () => {
    fs.mkdirSync(path.join(tmp, 'other'));
    svc.createTerminal('s1', 'claude-code', 'elsewhere', undefined, path.join(tmp, 'other'));
    expect(appState.get(db, 'last_directory')).toBe(path.join(tmp, 'other'));
  });
});
