// Regression (engineering review, top 15 #5): a thread stayed "working" for ever when its process
// died or hung, and nothing told the owner. The stall watchdog flags it. The watchdog only flags:
// it does not change the status. The owner can reset the status, and the flag then clears.
// Real database, real StatusService, the daemon's own watchdog wiring (createDaemonStallWatchdog).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { StatusService } from '../../src/status/service.js';
import { createDaemonStallWatchdog } from '../../src/runtime/stall-watchdog.js';

const MIN = 60_000;
let db: Database.Database;
let broadcaster: { broadcast: ReturnType<typeof vi.fn> };
let status: StatusService;
let now: number;
let frames: Map<string, number>;

const stallEvents = () => broadcaster.broadcast.mock.calls.map((c) => c[0]).filter((e: any) => e.type === 'terminal:stall');
const lifecycle = (id: string) => (status.diagnostics(id).events as { event_type: string }[]).map((e) => e.event_type);

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 'proj', provider: 'claude-code', name: 'p', workingDir: '/x' });
  for (const id of ['dead', 'busy', 'resting', 'gone']) terminalsDb.create(db, { id, sessionId: 'proj', type: 'claude-code', label: id, skipPermissions: true });
  broadcaster = { broadcast: vi.fn() };
  status = new StatusService(db, broadcaster);
  now = Date.parse('2026-11-09T10:00:00.000Z');
  frames = new Map();
});

const build = () => createDaemonStallWatchdog({ db, broadcaster, lastFrameAt: (id) => frames.get(id), now: () => now, thresholdMs: 10 * MIN });
const run = (dog: { tick(): void }, ms: number) => { for (let t = 0; t < ms; t += 30_000) { now += 30_000; dog.tick(); } };

describe('stale working status', () => {
  it('a working thread whose process is dead is explained and can be reset', () => {
    status.markWorking('dead'); // the turn started; then the process died and no settle ever came
    status.markWorking('busy');
    const dog = build();
    dog.tick();
    const seenAt = now;
    // "busy" keeps sending frames; "dead" sends none (no process: lastFrameAt is undefined).
    for (let i = 0; i < 22; i++) { now += 30_000; frames.set('busy', now); dog.tick(); }

    // Explained: one flag, one event to the clients, one lifecycle row.
    expect(dog.all()).toEqual([{ terminalId: 'dead', stalledSince: seenAt, lastFrameAt: null }]);
    expect(stallEvents()).toEqual([{ type: 'terminal:stall', terminalId: 'dead', stalledSince: new Date(seenAt).toISOString() }]);
    expect(lifecycle('dead').filter((t) => t.startsWith('stall.'))).toEqual(['stall.flagged']);
    expect(lifecycle('busy').filter((t) => t.startsWith('stall.'))).toEqual([]);
    // The watchdog did not change the status, and it sent no status event of its own.
    expect(terminalsDb.getById(db, 'dead')?.status).toBe('working');
    expect(broadcaster.broadcast.mock.calls.map((c) => c[0]).filter((e: any) => e.type === 'terminal:status' && e.terminalId === 'dead' && e.status !== 'working')).toEqual([]);

    // The owner resets the status; the next tick clears the flag.
    expect(status.resetStatus('dead')).toBe(true);
    expect(terminalsDb.getById(db, 'dead')?.status).toBe('waiting');
    run(dog, 30_000);
    expect(dog.all()).toEqual([]);
    expect(stallEvents().at(-1)).toEqual({ type: 'terminal:stall', terminalId: 'dead', stalledSince: null });
    expect(lifecycle('dead').filter((t) => t.startsWith('stall.')).sort()).toEqual(['stall.cleared', 'stall.flagged']);
  });

  it('a thread that is not working, and an archived working thread, are never flagged', () => {
    status.markWorking('gone');
    db.prepare("UPDATE terminals SET archived_at = '2026-11-09T09:00:00.000Z' WHERE id = 'gone'").run();
    const dog = build();
    dog.tick();
    run(dog, 30 * MIN);
    expect(dog.all()).toEqual([]);
    expect(stallEvents()).toEqual([]);
  });

  it('a tick after the database closed does nothing (shutdown)', () => {
    status.markWorking('dead');
    const dog = build();
    dog.tick();
    db.close();
    expect(() => run(dog, 12 * MIN)).not.toThrow();
  });
});
