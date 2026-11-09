import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as watchesDb from '../../src/db/watches.js';
import { WatchDispatcher, composeWakeMessage } from '../../src/sessions/watch-dispatcher.js';
import { DeliveryOutbox, type DeliverResult } from '../../src/delivery/outbox.js';
import { logLifecycle } from '../../src/runtime/diagnostics.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
  return db;
}

function makeTerminal(db: Database.Database, id: string, label = id): void {
  terminalsDb.create(db, { id, sessionId: 's1', type: 'claude-code', label });
}

function watchRow(db: Database.Database, id: string): any {
  return db.prepare('SELECT * FROM thread_watches WHERE id = ?').get(id);
}

describe('WatchDispatcher', () => {
  it('delivers exactly once to a matching watch and marks it fired', () => {
    const db = createTestDb();
    makeTerminal(db, 'watcher');
    makeTerminal(db, 'target', 'Fix login bug');
    const watchId = watchesDb.create(db, {
      watcherTerminalId: 'watcher', targetTerminalId: 'target', criteria: 'idle', note: 'review its diff',
    });
    const deliver = vi.fn();
    const dispatcher = new WatchDispatcher(db, deliver);

    dispatcher.onStatus('target', 'idle');

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toBe('watcher');
    expect(deliver.mock.calls[0][1]).toContain('review its diff');
    expect(watchesDb.liveForTarget(db, 'target', 'idle')).toHaveLength(0);
    expect(watchRow(db, watchId).fired_at).toBeTruthy();
  });

  it('a one-shot watch does NOT deliver again on a second matching edge', () => {
    const db = createTestDb();
    makeTerminal(db, 'watcher');
    makeTerminal(db, 'target');
    watchesDb.create(db, { watcherTerminalId: 'watcher', targetTerminalId: 'target', criteria: 'idle' });
    const deliver = vi.fn();
    const dispatcher = new WatchDispatcher(db, deliver);

    dispatcher.onStatus('target', 'idle');
    dispatcher.onStatus('target', 'idle');

    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('a repeating watch (once: false) fires again on a later matching edge', () => {
    const db = createTestDb();
    makeTerminal(db, 'watcher');
    makeTerminal(db, 'target');
    watchesDb.create(db, { watcherTerminalId: 'watcher', targetTerminalId: 'target', criteria: 'idle', once: false });
    const deliver = vi.fn();
    const dispatcher = new WatchDispatcher(db, deliver);

    dispatcher.onStatus('target', 'idle');
    dispatcher.onStatus('target', 'idle');

    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("criteria 'any' matches only notable statuses (idle, needs_input, error), not turn start", () => {
    const db = createTestDb();
    makeTerminal(db, 'watcher');
    makeTerminal(db, 'target');
    watchesDb.create(db, { watcherTerminalId: 'watcher', targetTerminalId: 'target', criteria: 'any', once: false });
    const deliver = vi.fn();
    const dispatcher = new WatchDispatcher(db, deliver);

    dispatcher.onStatus('target', 'idle');
    dispatcher.onStatus('target', 'error');
    dispatcher.onStatus('target', 'needs_input');

    expect(deliver).toHaveBeenCalledTimes(3);
  });

  it("an 'any' watch does NOT fire on 'working' and stays live afterwards", () => {
    const db = createTestDb();
    makeTerminal(db, 'watcher');
    makeTerminal(db, 'target');
    const watchId = watchesDb.create(db, { watcherTerminalId: 'watcher', targetTerminalId: 'target', criteria: 'any' });
    const deliver = vi.fn();
    const dispatcher = new WatchDispatcher(db, deliver);

    // First, call with 'working' — should NOT deliver
    dispatcher.onStatus('target', 'working');
    expect(deliver).not.toHaveBeenCalled();

    // Watch should still be live
    expect(watchesDb.liveForTarget(db, 'target', 'any')).toHaveLength(1);
    expect(watchRow(db, watchId).fired_at).toBeFalsy();

    // Then call with 'idle' — should deliver now
    dispatcher.onStatus('target', 'idle');
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('a working status edge performs no delivery at all', () => {
    const db = createTestDb();
    makeTerminal(db, 'watcher');
    makeTerminal(db, 'target');
    watchesDb.create(db, { watcherTerminalId: 'watcher', targetTerminalId: 'target', criteria: 'any', once: false });
    const deliver = vi.fn();
    const dispatcher = new WatchDispatcher(db, deliver);

    dispatcher.onStatus('target', 'working');

    expect(deliver).not.toHaveBeenCalled();
  });

  it('a non-matching status delivers nothing', () => {
    const db = createTestDb();
    makeTerminal(db, 'watcher');
    makeTerminal(db, 'target');
    watchesDb.create(db, { watcherTerminalId: 'watcher', targetTerminalId: 'target', criteria: 'error' });
    const deliver = vi.fn();
    const dispatcher = new WatchDispatcher(db, deliver);

    dispatcher.onStatus('target', 'idle');

    expect(deliver).not.toHaveBeenCalled();
  });

  it('removes the watch and delivers nothing when the watcher terminal row is gone', () => {
    const db = createTestDb();
    makeTerminal(db, 'target');
    const watchId = watchesDb.create(db, { watcherTerminalId: 'ghost', targetTerminalId: 'target', criteria: 'idle' });
    const deliver = vi.fn();
    const dispatcher = new WatchDispatcher(db, deliver);

    dispatcher.onStatus('target', 'idle');

    expect(deliver).not.toHaveBeenCalled();
    expect(watchRow(db, watchId)).toBeUndefined();
  });

  it('removes the watch and delivers nothing when the watcher terminal is archived', () => {
    const db = createTestDb();
    makeTerminal(db, 'watcher');
    makeTerminal(db, 'target');
    terminalsDb.archive(db, 'watcher');
    const watchId = watchesDb.create(db, { watcherTerminalId: 'watcher', targetTerminalId: 'target', criteria: 'idle' });
    const deliver = vi.fn();
    const dispatcher = new WatchDispatcher(db, deliver);

    dispatcher.onStatus('target', 'idle');

    expect(deliver).not.toHaveBeenCalled();
    expect(watchRow(db, watchId)).toBeUndefined();
  });

  // Changed for the delivery outbox (W2-C): the watch was marked fired though nothing was delivered,
  // so the wake was lost. It now stays live until a delivery succeeds.
  it('a throwing deliver does not propagate out of onStatus, and the watch is NOT marked fired', () => {
    const db = createTestDb();
    makeTerminal(db, 'watcher');
    makeTerminal(db, 'target');
    const watchId = watchesDb.create(db, { watcherTerminalId: 'watcher', targetTerminalId: 'target', criteria: 'idle' });
    const deliver = vi.fn(() => { throw new Error('transport exploded'); });
    const dispatcher = new WatchDispatcher(db, deliver);

    expect(() => dispatcher.onStatus('target', 'idle')).not.toThrow();
    expect(watchRow(db, watchId).fired_at).toBeNull();
  });

  it('multiple matching watches on the same target each deliver once', () => {
    const db = createTestDb();
    makeTerminal(db, 'watcher-a');
    makeTerminal(db, 'watcher-b');
    makeTerminal(db, 'target');
    watchesDb.create(db, { watcherTerminalId: 'watcher-a', targetTerminalId: 'target', criteria: 'idle' });
    watchesDb.create(db, { watcherTerminalId: 'watcher-b', targetTerminalId: 'target', criteria: 'idle' });
    const deliver = vi.fn();
    const dispatcher = new WatchDispatcher(db, deliver);

    dispatcher.onStatus('target', 'idle');

    expect(deliver).toHaveBeenCalledTimes(2);
    const recipients = deliver.mock.calls.map((c) => c[0]).sort();
    expect(recipients).toEqual(['watcher-a', 'watcher-b']);
  });
});

describe('composeWakeMessage', () => {
  it('names the target label + id, says what happened in plain language, echoes the note, and points at read_thread', () => {
    const text = composeWakeMessage({ id: 't_abc123', label: 'Fix login bug' }, 'idle', 'review its diff and report back');
    expect(text).toContain('Fix login bug');
    expect(text).toContain('t_abc123');
    expect(text).toContain('finished its turn');
    expect(text).toContain('review its diff and report back');
    expect(text).toContain('read_thread');
  });

  // The watcher ACTS on this text, so each status has to say what happened and what to
  // do next — "just went needs_input" reads as machine noise, and "see what it did" is
  // the wrong instruction when the peer is actually waiting on an answer.
  it('phrases needs_input as a question to answer, not something to inspect', () => {
    const text = composeWakeMessage({ id: 't_1', label: 'Migration' }, 'needs_input', null);
    expect(text).toContain('waiting on a question');
    expect(text).toMatch(/answer_agent|message_thread/);
    expect(text).not.toContain('needs_input');
  });

  it('phrases error as a failure to diagnose', () => {
    const text = composeWakeMessage({ id: 't_2', label: 'Build' }, 'error', null);
    expect(text).toContain('hit an error');
    expect(text).toContain('what went wrong');
  });

  it('omits the "You asked" clause when note is null', () => {
    const text = composeWakeMessage({ id: 't_abc123', label: 'Fix login bug' }, 'idle', null);
    expect(text).not.toContain('You asked');
    expect(text).toContain('Fix login bug');
    expect(text).toContain('read_thread');
  });
});

describe('composeWakeMessage control characters', () => {
  it('drops control characters and newlines from the note and the label', () => {
    const msg = composeWakeMessage({ id: 't1', label: 'La\x1b[2Jbel\r' }, 'idle', 'n1\nrun\x03 this');
    expect(msg).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(msg).toContain('n1 run this');
  });
});

// A watch registered AFTER the peer already settled never sees an edge. 2026-10-26: a worker
// ran `gh pr checks --watch` for ~6 minutes after spawning a reviewer, the reviewer went idle
// meanwhile, and the watch_thread call that followed never fired.
describe('WatchDispatcher.catchUp', () => {
  const TURN = '2026-10-26T15:53:28.117Z';
  const SETTLED = '2026-10-26T15:59:39.642Z';

  function setup(opts: { targetStatus: string; settle?: { type: string; at: string } | null; watcherStatus?: string; turnAt?: string | null }) {
    const db = createTestDb();
    makeTerminal(db, 'watcher');
    makeTerminal(db, 'target', 'Reviewer');
    terminalsDb.updateStatus(db, 'target', opts.targetStatus);
    if (opts.settle !== null) addEvent(db, 'target', opts.settle?.type ?? 'turn.completed', opts.settle?.at ?? SETTLED);
    terminalsDb.updateStatus(db, 'watcher', opts.watcherStatus ?? 'working');
    if (opts.turnAt !== null) {
      db.prepare("INSERT INTO usage_turns(id,terminal_id,project_id,provider,started_at) VALUES ('u1','watcher','s1','claude-code',?)").run(opts.turnAt ?? TURN);
    }
    return { db, dispatcher: new WatchDispatcher(db, vi.fn()) };
  }
  function addEvent(db: Database.Database, id: string, type: string, at: string) {
    db.prepare("INSERT INTO lifecycle_events(terminal_id,event_type,observed_at,disposition) VALUES (?,?,?,'applied')").run(id, type, at);
  }
  const watch = (db: Database.Database, criteria: any = 'idle', once = true, target = 'target') =>
    watchesDb.create(db, { watcherTerminalId: 'watcher', targetTerminalId: target, criteria, once });

  it('fires at once when the target went idle during the watcher\'s current turn, returning the wake text', () => {
    const { db, dispatcher } = setup({ targetStatus: 'waiting' });
    const id = watch(db);
    const text = dispatcher.catchUp(id);
    expect(text).toContain('finished its turn');
    expect(text).toContain('Reviewer');
    expect(watchRow(db, id).fired_at).toBeTruthy();
  });

  it('delivers nothing itself: the text is returned so the caller does not act twice', () => {
    const { db } = setup({ targetStatus: 'waiting' });
    const deliver = vi.fn();
    new WatchDispatcher(db, deliver).catchUp(watch(db));
    expect(deliver).not.toHaveBeenCalled();
  });

  it('does not fire when the target settled before the watcher\'s turn began', () => {
    const { db, dispatcher } = setup({ targetStatus: 'waiting', settle: { type: 'turn.completed', at: '2026-10-26T15:00:00.000Z' } });
    const id = watch(db);
    expect(dispatcher.catchUp(id)).toBeNull();
    expect(watchRow(db, id).fired_at).toBeNull();
  });

  it('is not fooled by a later last_activity_at stamp that came with no status change', () => {
    const { db, dispatcher } = setup({ targetStatus: 'waiting', settle: { type: 'turn.completed', at: '2026-10-26T15:00:00.000Z' } });
    db.prepare('UPDATE terminals SET last_activity_at = ? WHERE id = ?').run(SETTLED, 'target');
    expect(dispatcher.catchUp(watch(db))).toBeNull();
  });

  it('uses the stable turn start: a tool hook moving thread_lifecycle.observed_at does not hide an earlier settle', () => {
    const { db, dispatcher } = setup({ targetStatus: 'waiting' });
    db.prepare("INSERT INTO thread_lifecycle(terminal_id,status,source,observed_at) VALUES ('watcher','working','authoritative','2026-10-26T16:03:15.000Z')").run();
    expect(dispatcher.catchUp(watch(db))).toContain('finished its turn');
  });

  it('two targets that settled in the same turn both catch up', () => {
    const { db, dispatcher } = setup({ targetStatus: 'waiting' });
    makeTerminal(db, 'target2', 'Reviewer 2');
    terminalsDb.updateStatus(db, 'target2', 'waiting');
    addEvent(db, 'target2', 'turn.completed', '2026-10-26T16:00:10.000Z');
    expect(dispatcher.catchUp(watch(db))).toContain('Reviewer');
    expect(dispatcher.catchUp(watch(db, 'idle', true, 'target2'))).toContain('Reviewer 2');
  });

  it('falls back to thread_lifecycle.observed_at when the watcher has no open turn row', () => {
    const { db, dispatcher } = setup({ targetStatus: 'waiting', turnAt: null });
    db.prepare("INSERT INTO thread_lifecycle(terminal_id,status,source,observed_at) VALUES ('watcher','working','authoritative',?)").run(TURN);
    expect(dispatcher.catchUp(watch(db))).toContain('finished its turn');
  });

  it('does not fire while the target is working', () => {
    const { db, dispatcher } = setup({ targetStatus: 'working' });
    expect(dispatcher.catchUp(watch(db, 'any'))).toBeNull();
  });

  it('respects the criteria: an idle target does not satisfy an error watch', () => {
    const { db, dispatcher } = setup({ targetStatus: 'waiting' });
    expect(dispatcher.catchUp(watch(db, 'error'))).toBeNull();
  });

  it('maps needs_input and error terminal states, and "any" matches them', () => {
    for (const [state, event, phrase] of [['needs_input', 'permission.requested', 'waiting on a question'], ['error', 'turn.failed', 'hit an error']] as const) {
      const { db, dispatcher } = setup({ targetStatus: state, settle: { type: event, at: SETTLED } });
      expect(dispatcher.catchUp(watch(db, 'any'))).toContain(phrase);
    }
  });

  it('a process exit or revive is not a settle: no settling event, no fire', () => {
    const { db, dispatcher } = setup({ targetStatus: 'waiting', settle: { type: 'process.exited', at: SETTLED } });
    expect(dispatcher.catchUp(watch(db))).toBeNull();
  });

  it('permission, resume, then a clean exit is not a settle (the exit excludes it)', () => {
    const { db, dispatcher } = setup({ targetStatus: 'waiting', settle: { type: 'permission.requested', at: '2026-10-26T15:58:00.000Z' } });
    addEvent(db, 'target', 'permission.resolved', '2026-10-26T15:58:30.000Z');
    addEvent(db, 'target', 'process.exited', SETTLED);
    expect(dispatcher.catchUp(watch(db))).toBeNull();
  });

  it('a second idle event after the first does not make an old settle look new', () => {
    const { db, dispatcher } = setup({ targetStatus: 'waiting', settle: { type: 'status.idle', at: '2026-10-26T15:50:00.000Z' } });
    addEvent(db, 'target', 'status.idle', '2026-10-26T15:51:00.000Z'); // idle_prompt notification
    expect(dispatcher.catchUp(watch(db))).toBeNull(); // watcher turn began 15:53
  });

  it('an interrupted watcher turn leaves a stale open row: the real turn start is the first working event after its last settle', () => {
    const { db, dispatcher } = setup({ targetStatus: 'waiting', turnAt: '2026-10-26T09:00:00.000Z' });
    addEvent(db, 'watcher', 'status.idle', '2026-10-26T15:55:00.000Z');
    addEvent(db, 'watcher', 'turn.started', '2026-10-26T16:20:00.000Z'); // new turn; target settled 15:59, before it
    expect(dispatcher.catchUp(watch(db))).toBeNull();
  });

  it('the same stale row still catches up when the target settled after the real turn start', () => {
    const { db, dispatcher } = setup({ targetStatus: 'waiting', turnAt: '2026-10-26T09:00:00.000Z' });
    addEvent(db, 'watcher', 'status.idle', '2026-10-26T15:30:00.000Z');
    addEvent(db, 'watcher', 'turn.started', '2026-10-26T15:50:00.000Z');
    expect(dispatcher.catchUp(watch(db))).toContain('finished its turn'); // target settled 15:59:39
  });

  it('does nothing when the watcher is not in a turn', () => {
    const { db, dispatcher } = setup({ targetStatus: 'waiting', watcherStatus: 'waiting' });
    expect(dispatcher.catchUp(watch(db))).toBeNull();
  });

  it('a repeating watch is kept live after a catch-up fire', () => {
    const { db, dispatcher } = setup({ targetStatus: 'waiting' });
    expect(dispatcher.catchUp(watch(db, 'idle', false))).not.toBeNull();
    expect(watchesDb.liveForTarget(db, 'target', 'idle')).toHaveLength(1);
  });
});

// Drives the real StatusService with Claude CLI hook payloads, so the cutoff is whatever the
// status machine really writes (a PreToolUse hook fires before watch_thread itself runs).
describe('WatchDispatcher.catchUp through StatusService', () => {
  it('catches up for a Claude CLI watcher whose tool hooks fire after the target settled', async () => {
    const { StatusService } = await import('../../src/status/service.js');
    const db = createTestDb();
    makeTerminal(db, 'watcher');
    makeTerminal(db, 'target', 'Reviewer');
    const { attachPtyCapture } = await import('../../src/analytics/pty-capture.js');
    const status = new StatusService(db, { broadcast: () => {} } as any);
    status.addTurnBoundaryListener(attachPtyCapture({ db, isStructured: () => false })); // same wiring as server.ts
    const hook = (id: string, name: string, extra: object = {}) => status.ingest('claude-code', id, { hook_event_name: name, session_id: `sid-${id}`, ...extra });
    hook('watcher', 'UserPromptSubmit', { prompt: 'go' });
    await new Promise((r) => setTimeout(r, 15));
    hook('target', 'UserPromptSubmit', { prompt: 'review' });
    await new Promise((r) => setTimeout(r, 15));
    hook('target', 'Stop');
    await new Promise((r) => setTimeout(r, 15));
    hook('watcher', 'PreToolUse', { tool_name: 'mcp__dispatch__watch_thread', tool_input: {} });
    const id = watchesDb.create(db, { watcherTerminalId: 'watcher', targetTerminalId: 'target', criteria: 'idle' });
    expect(new WatchDispatcher(db, vi.fn()).catchUp(id)).toContain('finished its turn');
  });
});

// The delivery outbox (W2-C): a wake that cannot be delivered waits, and the watch is spent only
// when the wake reached the watcher.
describe('WatchDispatcher with the delivery outbox', () => {
  function setup() {
    const db = createTestDb();
    makeTerminal(db, 'watcher');
    makeTerminal(db, 'target', 'Worker');
    const alive = new Set<string>();
    const got: { to: string; text: string }[] = [];
    let fail = false;
    const outbox = new DeliveryOutbox({
      db,
      deliver: (to, text): DeliverResult => {
        if (fail) throw new Error('transport exploded');
        const row = terminalsDb.getById(db, to);
        if (!row || row.archived_at) return 'gone';
        if (!alive.has(to)) return 'not-alive';
        got.push({ to, text });
        return 'delivered';
      },
    });
    const dispatcher = new WatchDispatcher(db, outbox);
    /** The target settles: one lifecycle event, then the status edge (the order StatusService uses). */
    const settle = (status = 'idle') => {
      logLifecycle(db, { terminalId: 'target', type: `status.${status}`, observedAt: new Date().toISOString() }, 'applied');
      dispatcher.onStatus('target', status);
    };
    return { db, alive, got, outbox, dispatcher, settle, failing: (on: boolean) => { fail = on; } };
  }

  it('a one-shot watch stays live when delivery fails and fires when the watcher runs again', () => {
    const c = setup();
    const watchId = watchesDb.create(c.db, { watcherTerminalId: 'watcher', targetTerminalId: 'target', criteria: 'idle', note: 'review it' });
    c.settle(); // the watcher is not running
    expect(c.got).toHaveLength(0);
    expect(watchRow(c.db, watchId).fired_at).toBeNull();
    expect(watchesDb.listByWatcher(c.db, 'watcher')).toHaveLength(1); // still listed as live
    expect(c.outbox.list({ terminalId: 'watcher', state: 'pending' })).toHaveLength(1);

    c.alive.add('watcher');
    c.outbox.flush('watcher'); // the event: the watcher's process started
    expect(c.got).toHaveLength(1);
    expect(c.got[0].text).toContain('review it');
    expect(watchRow(c.db, watchId).fired_at).toBeTruthy();
    expect(watchRow(c.db, watchId).pending_delivery_id).toBeNull();
    expect(watchesDb.listByWatcher(c.db, 'watcher')).toHaveLength(0);
  });

  it('a watch is marked fired only after the delivery', () => {
    const c = setup();
    const watchId = watchesDb.create(c.db, { watcherTerminalId: 'watcher', targetTerminalId: 'target', criteria: 'idle' });
    const firedWhenDelivered: unknown[] = [];
    const outbox = new DeliveryOutbox({
      db: c.db,
      deliver: () => { firedWhenDelivered.push(watchRow(c.db, watchId).fired_at); return 'delivered'; },
    });
    new WatchDispatcher(c.db, outbox).onStatus('target', 'idle');
    expect(firedWhenDelivered).toEqual([null]); // not yet fired while the delivery ran
    expect(watchRow(c.db, watchId).fired_at).toBeTruthy(); // fired after it
  });

  it('a delivery that throws leaves the watch live, and a later flush fires it', () => {
    const c = setup();
    const watchId = watchesDb.create(c.db, { watcherTerminalId: 'watcher', targetTerminalId: 'target', criteria: 'idle' });
    c.alive.add('watcher');
    c.failing(true);
    c.settle();
    expect(watchRow(c.db, watchId).fired_at).toBeNull();
    c.failing(false);
    c.outbox.flush('watcher');
    expect(c.got).toHaveLength(1);
    expect(watchRow(c.db, watchId).fired_at).toBeTruthy();
  });

  it('the same settle event does not enqueue twice', () => {
    const c = setup();
    watchesDb.create(c.db, { watcherTerminalId: 'watcher', targetTerminalId: 'target', criteria: 'idle', once: false });
    c.alive.add('watcher');
    c.settle();
    c.dispatcher.onStatus('target', 'idle'); // the same settle, reported again
    expect(c.got).toHaveLength(1);
    expect(c.outbox.list({ terminalId: 'watcher' })).toHaveLength(1);
    c.settle(); // a new settle event: a repeating watch fires again
    expect(c.got).toHaveLength(2);
  });

  it('a watch with a pending wake is not matched again', () => {
    const c = setup();
    watchesDb.create(c.db, { watcherTerminalId: 'watcher', targetTerminalId: 'target', criteria: 'any' });
    watchesDb.create(c.db, { watcherTerminalId: 'watcher', targetTerminalId: 'target', criteria: 'any', once: false });
    c.settle('idle');
    c.settle('error');
    c.settle('idle');
    expect(c.outbox.list({ terminalId: 'watcher' })).toHaveLength(2); // one wake for each watch, no more
    c.alive.add('watcher');
    c.outbox.flush('watcher');
    expect(c.got).toHaveLength(2);
    c.settle('idle'); // the repeating watch is live again; the one-shot is spent
    expect(c.got).toHaveLength(3);
  });

  it('a pending wake whose watcher is archived is dropped and the watch is removed', () => {
    const c = setup();
    const watchId = watchesDb.create(c.db, { watcherTerminalId: 'watcher', targetTerminalId: 'target', criteria: 'idle' });
    c.settle();
    terminalsDb.archive(c.db, 'watcher');
    c.outbox.flush('watcher');
    expect(c.outbox.list({ terminalId: 'watcher' })[0]).toMatchObject({ state: 'dropped' });
    expect(watchRow(c.db, watchId)).toBeUndefined();
  });

  it('a wake dropped after five failed attempts leaves the watch live for the next settle', () => {
    const c = setup();
    const watchId = watchesDb.create(c.db, { watcherTerminalId: 'watcher', targetTerminalId: 'target', criteria: 'idle' });
    c.alive.add('watcher');
    c.failing(true);
    c.settle();
    for (let i = 0; i < 4; i++) c.outbox.flush('watcher');
    expect(c.outbox.list({ terminalId: 'watcher' })[0]).toMatchObject({ state: 'dropped', attempts: 5 });
    expect(watchRow(c.db, watchId)).toMatchObject({ fired_at: null, pending_delivery_id: null });
    c.failing(false);
    c.settle();
    expect(c.got).toHaveLength(1);
    expect(watchRow(c.db, watchId).fired_at).toBeTruthy();
  });

  it('a wake survives a restart: a new outbox and dispatcher on the same database deliver it once', () => {
    const c = setup();
    const watchId = watchesDb.create(c.db, { watcherTerminalId: 'watcher', targetTerminalId: 'target', criteria: 'idle' });
    c.settle();
    // The "new daemon": nothing in memory is kept.
    const got: string[] = [];
    const outbox = new DeliveryOutbox({ db: c.db, deliver: (_to, text) => { got.push(text); return 'delivered'; } });
    new WatchDispatcher(c.db, outbox);
    expect(outbox.flushAll()).toBe(1);
    expect(outbox.flushAll()).toBe(0);
    expect(got).toHaveLength(1);
    expect(watchRow(c.db, watchId).fired_at).toBeTruthy();
  });

  it('removeForTerminal removes the rows addressed to the deleted thread', () => {
    const c = setup();
    watchesDb.create(c.db, { watcherTerminalId: 'watcher', targetTerminalId: 'target', criteria: 'idle' });
    c.settle();
    watchesDb.removeForTerminal(c.db, 'watcher');
    expect(c.outbox.list({ terminalId: 'watcher' })).toHaveLength(0);
  });
});
