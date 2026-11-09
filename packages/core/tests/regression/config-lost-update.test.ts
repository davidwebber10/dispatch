import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../../src/db/connection.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { clearTranscriptPathCache } from '../../src/sessions/transcript-path.js';
import { SessionService } from '../../src/sessions/service.js';
import { StatusService } from '../../src/status/service.js';
import { ThreadConfigStore } from '../../src/sessions/thread-config.js';
import type { IStructuredManager } from '../../src/structured/manager.js';

// Engineering program 1A.2, bug class "Lost config update, real path" (W2-A).
// The config is one JSON column. A writer that wrote the whole object from a copy it read earlier
// dropped the change that another writer made in between. These tests drive the real services
// (SessionService and StatusService) on one database and assert that no change is lost.

class FakePty extends EventEmitter {
  isAlive() { return false; }
  kill() {}
  spawn() { return 1234; }
  setDefaultEnv() {}
}

class FakeStructured extends EventEmitter implements IStructuredManager {
  live = new Set<string>();
  spawns: string[] = [];
  sent: string[] = [];
  /** Runs inside setModel, before the harness answers: the place where another writer gets in. */
  duringSetModel: (() => void) | null = null;
  /** Runs inside spawn. */
  duringSpawn: ((id: string) => void) | null = null;
  setDefaultEnv() {}
  spawn(id: string) { this.live.add(id); this.spawns.push(id); this.duringSpawn?.(id); return 4321; }
  sendMessage(id: string) { this.sent.push(id); }
  answerPermission() { return false; }
  setEscalate() { return false; }
  interrupt() { return true; }
  compact() {}
  noteDeclaredStatus() {}
  getPending() { return null; }
  getSessionId() { return undefined; }
  getEvents() { return []; }
  getEventsTail() { return []; }
  getTurnTexts(): string[] | null { return null; }
  getModel() { return undefined; }
  async setModel(_id: string, model: string) {
    await new Promise((r) => setImmediate(r));
    this.duringSetModel?.();
    await new Promise((r) => setImmediate(r));
    return model;
  }
  isAlive(id: string) { return this.live.has(id); }
  kill(id: string) { this.live.delete(id); this.emit('exit', id, 0); }
  killAll() { this.live.clear(); }
}

let dir: string;
let db: Database.Database;
let svc: SessionService;
let status: StatusService;
let structured: FakeStructured;
let origHome: string | undefined;

const cfg = (id: string): Record<string, any> => JSON.parse(terminalsDb.getById(db, id)!.config || '{}');

function seed(id: string, config: Record<string, unknown>, opts: { status?: string; externalId?: string } = {}) {
  terminalsDb.create(db, { id, sessionId: 's1', type: 'claude-code', label: id, workingDir: path.join(dir, 'proj'), externalId: opts.externalId, config });
  if (opts.status) terminalsDb.updateStatus(db, id, opts.status);
}

beforeEach(() => {
  origHome = process.env.HOME;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-config-lost-'));
  fs.mkdirSync(path.join(dir, 'proj'), { recursive: true });
  process.env.HOME = dir;
  clearTranscriptPathCache();
  db = createDatabase(path.join(dir, 'test.db'));
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'proj', workingDir: path.join(dir, 'proj') });
  structured = new FakeStructured();
  svc = new SessionService(db, new FakePty() as any, path.join(dir, 'mcp.json'));
  svc.setStructuredManager(structured);
  status = new StatusService(db, { broadcast: () => {} });
});
afterEach(() => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  clearTranscriptPathCache();
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('lost config update, real path', () => {
  it('a model switch during a status write keeps the scheduled wake', async () => {
    // The owner marked the thread "complete" on the board; the thread has other settings too.
    seed('t1', { transport: 'structured', alertsEnabled: true, autoArchive: true, autoArchiveMs: 60_000, boardState: { acknowledgedAt: '2026-11-01T00:00:00.000Z', override: 'complete' } }, { status: 'waiting' });
    structured.live.add('t1');
    // While the harness answers the model switch, the thread goes dormant: the status write
    // clears the board override (real activity) and stamps the scheduled wake.
    structured.duringSetModel = () => status.markScheduled('t1', 'Wakes at 09:00');

    const out = await svc.setThreadModel('t1', 'sonnet');

    expect(out.model).toBe('sonnet');
    const after = cfg('t1');
    // The model switch landed.
    expect(after.model).toBe('sonnet');
    expect(typeof after.modelSetAt).toBe('number');
    // The status write landed whole: the wake, and the override clear made inside the same write.
    expect(after.scheduledWake).toBe('Wakes at 09:00');
    expect(after.boardState).toEqual({ acknowledgedAt: '2026-11-01T00:00:00.000Z', override: null });
    // No other key was lost.
    expect(after).toMatchObject({ transport: 'structured', alertsEnabled: true, autoArchive: true, autoArchiveMs: 60_000 });
    expect(terminalsDb.getById(db, 't1')!.status).toBe('scheduled');
  });

  it('a status write that clears the board override is not undone by the scheduled-wake stamp', () => {
    seed('t1', { transport: 'structured', boardState: { override: 'complete' }, model: 'opus' }, { status: 'working' });
    status.markScheduled('t1');
    expect(cfg('t1')).toEqual({ transport: 'structured', model: 'opus', boardState: { override: null }, scheduledWake: 'Scheduled — will resume automatically' });
  });

  it('the boot kickstart keeps the keys that the start of the thread wrote', async () => {
    // A coordinator left `working` by the last shutdown, with no saved model: the start resolves
    // the model and saves it. The kick stamp that follows must not write the copy from before.
    seed('c1', { transport: 'structured', role: 'coordinator', interruptedAt: '2026-11-08T00:00:00.000Z' }, { status: 'working' });
    const store = new ThreadConfigStore(db);
    // Another writer lands while the thread starts (a turn outcome, an alert switch).
    structured.duringSpawn = (id) => { store.patch(id, { alertsEnabled: true }); };

    const result = await svc.kickstartInterruptedAgents(0);

    expect(result.kicked).toEqual(['c1']);
    const after = cfg('c1');
    expect(typeof after.kickedAt).toBe('string');
    expect(after.interruptedAt).toBeUndefined();
    expect(after.alertsEnabled).toBe(true);
    expect(typeof after.model).toBe('string'); // saved by the start, kept by the kick stamp
    expect(after).toMatchObject({ transport: 'structured', role: 'coordinator' });
  });

  it('a turn outcome written while the thread starts survives the start', () => {
    seed('q1', { transport: 'structured', role: 'agent', queued: true, queuedTask: 'do the work', dependsOn: 'other' }, { status: 'queued' });
    const store = new ThreadConfigStore(db);
    structured.duringSpawn = (id) => { store.patch(id, { scheduledWake: 'written during the start' }); };

    svc.startQueuedTerminal('q1');

    const after = cfg('q1');
    expect(after.queued).toBeUndefined();
    expect(after.queuedTask).toBeUndefined();
    expect(after.dependsOn).toBeUndefined();
    expect(after.scheduledWake).toBe('written during the start');
    expect(after).toMatchObject({ transport: 'structured', role: 'agent' });
  });

  it('shutdown and the next boot: the interrupted stamp and the kick stamp keep every other key', async () => {
    seed('c1', { transport: 'structured', role: 'coordinator', model: 'opus', alertsEnabled: true, secretsEnv: true }, { status: 'working' });
    structured.live.add('c1');
    const restored = svc.shutdownPreservingInterruptedTurns(() => structured.kill('c1'));
    expect(restored).toEqual(['c1']);
    expect(cfg('c1')).toMatchObject({ transport: 'structured', role: 'coordinator', model: 'opus', alertsEnabled: true, secretsEnv: true });
    expect(typeof cfg('c1').interruptedAt).toBe('string');

    await svc.kickstartInterruptedAgents(0);
    const after = cfg('c1');
    expect(after.interruptedAt).toBeUndefined();
    expect(typeof after.kickedAt).toBe('string');
    expect(after).toMatchObject({ transport: 'structured', role: 'coordinator', model: 'opus', alertsEnabled: true, secretsEnv: true });
  });
});
