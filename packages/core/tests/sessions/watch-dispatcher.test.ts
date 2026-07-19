import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as watchesDb from '../../src/db/watches.js';
import { WatchDispatcher, composeWakeMessage } from '../../src/sessions/watch-dispatcher.js';

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

  it('a throwing deliver does not propagate out of onStatus, and the watch is still marked fired', () => {
    const db = createTestDb();
    makeTerminal(db, 'watcher');
    makeTerminal(db, 'target');
    const watchId = watchesDb.create(db, { watcherTerminalId: 'watcher', targetTerminalId: 'target', criteria: 'idle' });
    const deliver = vi.fn(() => { throw new Error('transport exploded'); });
    const dispatcher = new WatchDispatcher(db, deliver);

    expect(() => dispatcher.onStatus('target', 'idle')).not.toThrow();
    expect(watchRow(db, watchId).fired_at).toBeTruthy();
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
