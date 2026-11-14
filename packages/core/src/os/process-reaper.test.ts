import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { DORMANT_KEY, ProcessReaper, createProcessReaper, isDormantStop, reaperSettings, resetDormantStateForTest, viewMayStart, type ReaperSettings } from './process-reaper.js';
import type { IStructuredManager } from '../structured/manager.js';

/** A manager with no process: what the reaper reads and calls, nothing more. */
class FakeManager extends EventEmitter {
  alive = new Set<string>();
  frames = new Map<string, number>();
  pending = new Set<string>();
  subagents = new Map<string, Array<{ state: string }>>();
  spawned: string[] = [];
  spawn(id: string): number { this.alive.add(id); this.spawned.push(id); return 1000 + this.spawned.length; }
  isAlive(id: string): boolean { return this.alive.has(id); }
  kill(id: string): void { if (this.alive.delete(id)) this.emit('exit', id, 0); }
  lastFrameAt(id: string): number | undefined { return this.frames.get(id); }
  getPending(id: string): unknown { return this.pending.has(id) ? { requestId: 'r' } : null; }
  listSubagents(id: string) { return this.subagents.get(id) ?? []; }
  killAll(): void { for (const id of [...this.alive]) this.kill(id); }
}

const MIN = 60_000;
let db: Database.Database;
let now: number;
let logs: Array<[string, Record<string, unknown>]>;

beforeEach(() => {
  resetDormantStateForTest();
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 'P', provider: 'claude-code', name: 'P', workingDir: '/tmp' });
  now = 1_000_000;
  logs = [];
});
afterEach(() => { db.close(); vi.unstubAllEnvs(); });

function thread(id: string, type = 'claude-code', config: Record<string, unknown> = { transport: 'structured' }, status = 'idle') {
  terminalsDb.create(db, { id, sessionId: 'P', type, label: id, config });
  terminalsDb.updateStatus(db, id, status);
}

function reaper(settings: ReaperSettings, managers = new Map<string, FakeManager>([['claude-code', new FakeManager()]])) {
  const stopped: string[] = [];
  const r = new ProcessReaper({
    db, managers: managers as unknown as Map<string, IStructuredManager>,
    stop: (id) => { stopped.push(id); for (const m of managers.values()) m.kill(id); },
    settings, log: (e, f) => { logs.push([e, f]); }, now: () => now, rssKb: () => 2048,
  });
  r.attach();
  const claude = managers.get('claude-code')!;
  const start = (id: string) => (claude as unknown as IStructuredManager).spawn(id, { command: 'x', args: [], workDir: '/tmp' });
  return { r, stopped, claude, managers, start };
}

describe('settings', () => {
  test('off unless the host sets a variable: a local install gets no reaper', () => {
    vi.stubEnv('DISPATCH_IDLE_PROCESS_MINUTES', '');
    vi.stubEnv('DISPATCH_MAX_LIVE_PROCESSES', '');
    expect(reaperSettings()).toBeNull();
    expect(createProcessReaper({ db, managers: new Map(), stop: () => {}, log: () => {} })).toBeNull();
    vi.stubEnv('DISPATCH_IDLE_PROCESS_MINUTES', '0');
    vi.stubEnv('DISPATCH_MAX_LIVE_PROCESSES', '0');
    expect(reaperSettings()).toBeNull();
    vi.stubEnv('DISPATCH_IDLE_PROCESS_MINUTES', '15');
    expect(reaperSettings()).toEqual({ idleMs: 15 * MIN, maxLive: 0 });
    vi.stubEnv('DISPATCH_MAX_LIVE_PROCESSES', '12');
    expect(reaperSettings()).toEqual({ idleMs: 15 * MIN, maxLive: 12 });
  });

  test('without the reaper, viewing always may start a process (desktop behaviour)', () => {
    expect(viewMayStart({ [DORMANT_KEY]: '2026-01-01T00:00:00.000Z' }, 't', null)).toBe(true);
    expect(viewMayStart({}, 't', { idleMs: MIN, maxLive: 0 })).toBe(true);
    expect(viewMayStart({ [DORMANT_KEY]: '2026-01-01T00:00:00.000Z' }, 't', { idleMs: MIN, maxLive: 0 })).toBe(false);
  });
});

describe('idle stop', () => {
  test('an idle thread is stopped after the timeout, and not before; it is then dormant', () => {
    thread('a');
    const { r, stopped, start } = reaper({ idleMs: 15 * MIN, maxLive: 0 });
    start('a');
    now += 15 * MIN - 1;
    r.tick();
    expect(stopped).toEqual([]);
    now += 1;
    r.tick();
    expect(stopped).toEqual(['a']);
    expect(isDormantStop('a')).toBe(true);
    expect(terminalsDb.getById(db, 'a')!.config).toMatch(DORMANT_KEY);
    expect(logs.find(([e]) => e === 'thread.process_stopped')?.[1]).toMatchObject({ thread: 'a', reason: 'idle' });
    expect(logs.filter(([e]) => e === 'host.live_processes').map(([, f]) => f.count)).toEqual([1, 0]);
  });

  test('a frame or a message is use: the clock starts again', () => {
    thread('a');
    const { r, stopped, start, claude } = reaper({ idleMs: 15 * MIN, maxLive: 0 });
    start('a');
    now += 10 * MIN;
    claude.emit('event', 'a', { type: 'assistant' });
    now += 10 * MIN;
    r.tick();
    expect(stopped).toEqual([]);
    claude.emit('busy', 'a');
    now += 14 * MIN;
    r.tick();
    expect(stopped).toEqual([]);
  });

  test('an open turn, a pending approval, a running subagent or a role run is never stopped', () => {
    for (const s of ['working', 'needs_input', 'starting', 'queued', 'scheduled']) thread(`s-${s}`, 'claude-code', { transport: 'structured' }, s);
    thread('pending'); thread('sub'); thread('role', 'claude-code', { transport: 'structured', roleRun: 'run-1' }); thread('idle');
    const { r, stopped, start, claude } = reaper({ idleMs: MIN, maxLive: 0 });
    for (const id of ['s-working', 's-needs_input', 's-starting', 's-queued', 's-scheduled', 'pending', 'sub', 'role', 'idle']) start(id);
    claude.pending.add('pending');
    claude.subagents.set('sub', [{ state: 'done' }, { state: 'working' }]);
    now += 60 * MIN;
    r.tick();
    expect(stopped).toEqual(['idle']);
  });

  test('a Codex thread (one shared app-server) is neither counted nor stopped', () => {
    thread('c', 'codex');
    const codex = new FakeManager();
    const { r, stopped } = reaper({ idleMs: MIN, maxLive: 1 }, new Map([['claude-code', new FakeManager()], ['codex', codex]]));
    codex.spawn('c');
    now += 60 * MIN;
    r.tick();
    expect(stopped).toEqual([]);
    expect(r.liveThreads()).toEqual([]);
  });
});

describe('live cap', () => {
  test('the 13th start on a 12-cap host stops the least recently used idle process, not a busy one', () => {
    for (let i = 1; i <= 13; i++) thread(`t${i}`);
    const { r, stopped, start } = reaper({ idleMs: 0, maxLive: 12 });
    for (let i = 1; i <= 12; i++) { start(`t${i}`); now += 1000; }
    // t1 is the oldest but mid-turn; t2 is the least recently used idle one.
    terminalsDb.updateStatus(db, 't1', 'working');
    start('t13');
    expect(stopped).toEqual(['t2']);
    expect(r.liveThreads()).toHaveLength(12);
    expect(logs.find(([e]) => e === 'thread.process_stopped')?.[1]).toMatchObject({ thread: 't2', reason: 'lru' });
  });

  test('when every process is busy the start goes ahead and live_cap_exceeded is logged', () => {
    thread('a', 'claude-code', { transport: 'structured' }, 'working');
    thread('b');
    const { r, stopped, start } = reaper({ idleMs: 0, maxLive: 1 });
    start('a');
    start('b');
    expect(stopped).toEqual([]);
    expect(r.liveThreads()).toHaveLength(2);
    expect(logs.find(([e]) => e === 'live_cap_exceeded')?.[1]).toMatchObject({ live: 2, cap: 1 });
  });
});

describe('dormant and resume', () => {
  test('a start of a dormant thread ends the dormant state and logs the resume once its first frame arrives', () => {
    thread('a');
    const { r, start, claude } = reaper({ idleMs: MIN, maxLive: 0 });
    start('a');
    now += 2 * MIN;
    r.tick();
    expect(isDormantStop('a')).toBe(true);
    now += 5;
    start('a');
    expect(isDormantStop('a')).toBe(false);
    expect(terminalsDb.getById(db, 'a')!.config).not.toMatch(DORMANT_KEY);
    claude.emit('event', 'a', { type: 'user' }); // the daemon's own echo: not the CLI
    expect(logs.some(([e]) => e === 'thread.process_resumed')).toBe(false);
    now += 40;
    claude.emit('event', 'a', { type: 'system', subtype: 'init' });
    expect(logs.find(([e]) => e === 'thread.process_resumed')?.[1]).toMatchObject({ thread: 'a', startMs: 40 });
  });

  test('a daemon restart keeps a dormant thread dormant: the mark is in the config', () => {
    thread('a');
    const first = reaper({ idleMs: MIN, maxLive: 0 });
    first.start('a');
    now += 2 * MIN;
    first.r.tick();
    resetDormantStateForTest(); // the new daemon has no memory of the stop
    const config = JSON.parse(terminalsDb.getById(db, 'a')!.config ?? '{}');
    expect(viewMayStart(config, 'a', { idleMs: MIN, maxLive: 0 })).toBe(false);
    // The next start (a message) ends it.
    const second = reaper({ idleMs: MIN, maxLive: 0 });
    second.start('a');
    expect(viewMayStart(JSON.parse(terminalsDb.getById(db, 'a')!.config ?? '{}'), 'a', { idleMs: MIN, maxLive: 0 })).toBe(true);
  });

  test('a stop that throws leaves the thread not dormant', () => {
    thread('a');
    const managers = new Map([['claude-code', new FakeManager()]]);
    const r = new ProcessReaper({ db, managers: managers as any, stop: () => { throw new Error('boom'); }, settings: { idleMs: MIN, maxLive: 0 }, log: (e, f) => { logs.push([e, f]); }, now: () => now, rssKb: () => 0 });
    r.attach();
    (managers.get('claude-code') as any).spawn('a', {});
    now += 2 * MIN;
    r.tick();
    expect(isDormantStop('a')).toBe(false);
    expect(terminalsDb.getById(db, 'a')!.config).not.toMatch(DORMANT_KEY);
    expect(logs.some(([e]) => e === 'thread.process_stop_failed')).toBe(true);
  });
});
