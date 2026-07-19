import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as watchesDb from '../../src/db/watches.js';

function createTestDb() {
  const db = new Database(':memory:');
  initSchema(db);
  return db;
}

describe('watches db', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('creates and retrieves a watch (round-trip via listByWatcher/listByTarget)', () => {
    const id = watchesDb.create(db, {
      watcherTerminalId: 'a',
      targetTerminalId: 'b',
      criteria: 'idle',
      note: 'ping me',
    });
    expect(id).toBeTruthy();

    const byWatcher = watchesDb.listByWatcher(db, 'a');
    expect(byWatcher).toHaveLength(1);
    expect(byWatcher[0].id).toBe(id);
    expect(byWatcher[0].watcher_terminal_id).toBe('a');
    expect(byWatcher[0].target_terminal_id).toBe('b');
    expect(byWatcher[0].criteria).toBe('idle');
    expect(byWatcher[0].note).toBe('ping me');
    expect(byWatcher[0].once).toBe(1);
    expect(byWatcher[0].fired_at).toBeNull();
    expect(byWatcher[0].created_at).toBeTruthy();

    const byTarget = watchesDb.listByTarget(db, 'b');
    expect(byTarget).toHaveLength(1);
    expect(byTarget[0].id).toBe(id);
  });

  // One-shot is the default: a watch registered as "tell me when X finishes" must not
  // re-fire on every subsequent idle of X. Repeating requires an explicit once: false.
  it('create defaults note to null and once to 1 (one-shot) when omitted', () => {
    const id = watchesDb.create(db, { watcherTerminalId: 'a', targetTerminalId: 'b', criteria: 'any' });
    const row = watchesDb.listByWatcher(db, 'a').find(w => w.id === id)!;
    expect(row.note).toBeNull();
    expect(row.once).toBe(1);
  });

  it('create stores once = 1 when explicitly requested', () => {
    const id = watchesDb.create(db, { watcherTerminalId: 'a', targetTerminalId: 'b', criteria: 'error', once: true });
    const row = watchesDb.listByWatcher(db, 'a').find(w => w.id === id)!;
    expect(row.once).toBe(1);
  });

  it('create stores once = 0 only when repeating is explicitly requested', () => {
    const id = watchesDb.create(db, { watcherTerminalId: 'a', targetTerminalId: 'b', criteria: 'error', once: false });
    const row = watchesDb.listByWatcher(db, 'a').find(w => w.id === id)!;
    expect(row.once).toBe(0);
  });

  it('listByWatcher/listByTarget only return rows for the given terminal', () => {
    watchesDb.create(db, { watcherTerminalId: 'a', targetTerminalId: 'b', criteria: 'idle' });
    watchesDb.create(db, { watcherTerminalId: 'c', targetTerminalId: 'd', criteria: 'idle' });
    expect(watchesDb.listByWatcher(db, 'a')).toHaveLength(1);
    expect(watchesDb.listByWatcher(db, 'c')).toHaveLength(1);
    expect(watchesDb.listByTarget(db, 'b')).toHaveLength(1);
    expect(watchesDb.listByTarget(db, 'd')).toHaveLength(1);
  });

  describe('liveForTarget', () => {
    it('matches exact criteria', () => {
      watchesDb.create(db, { watcherTerminalId: 'a', targetTerminalId: 'b', criteria: 'idle' });
      const matches = watchesDb.liveForTarget(db, 'b', 'idle');
      expect(matches).toHaveLength(1);
    });

    it('matches criteria "any" regardless of status', () => {
      watchesDb.create(db, { watcherTerminalId: 'a', targetTerminalId: 'b', criteria: 'any' });
      expect(watchesDb.liveForTarget(db, 'b', 'idle')).toHaveLength(1);
      expect(watchesDb.liveForTarget(db, 'b', 'error')).toHaveLength(1);
      expect(watchesDb.liveForTarget(db, 'b', 'needs_input')).toHaveLength(1);
    });

    it('does not match a different, non-"any" status', () => {
      watchesDb.create(db, { watcherTerminalId: 'a', targetTerminalId: 'b', criteria: 'idle' });
      expect(watchesDb.liveForTarget(db, 'b', 'error')).toHaveLength(0);
      expect(watchesDb.liveForTarget(db, 'b', 'needs_input')).toHaveLength(0);
    });

    it('does not match watches on a different target', () => {
      watchesDb.create(db, { watcherTerminalId: 'a', targetTerminalId: 'b', criteria: 'idle' });
      expect(watchesDb.liveForTarget(db, 'other-target', 'idle')).toHaveLength(0);
    });
  });

  describe('markFired', () => {
    it('hides a once=1 row from live results after firing', () => {
      const id = watchesDb.create(db, { watcherTerminalId: 'a', targetTerminalId: 'b', criteria: 'idle', once: true });
      expect(watchesDb.liveForTarget(db, 'b', 'idle')).toHaveLength(1);

      watchesDb.markFired(db, id);

      expect(watchesDb.liveForTarget(db, 'b', 'idle')).toHaveLength(0);
      expect(watchesDb.listByWatcher(db, 'a')).toHaveLength(0);
      expect(watchesDb.listByTarget(db, 'b')).toHaveLength(0);
    });

    it('leaves a once=0 (repeating) row live after firing', () => {
      const id = watchesDb.create(db, { watcherTerminalId: 'a', targetTerminalId: 'b', criteria: 'idle', once: false });

      watchesDb.markFired(db, id);

      const live = watchesDb.liveForTarget(db, 'b', 'idle');
      expect(live).toHaveLength(1);
      expect(live[0].fired_at).toBeTruthy();
      expect(watchesDb.listByWatcher(db, 'a')).toHaveLength(1);
      expect(watchesDb.listByTarget(db, 'b')).toHaveLength(1);
    });
  });

  describe('remove', () => {
    it('deletes the row and returns true', () => {
      const id = watchesDb.create(db, { watcherTerminalId: 'a', targetTerminalId: 'b', criteria: 'idle' });
      expect(watchesDb.remove(db, id)).toBe(true);
      expect(watchesDb.listByWatcher(db, 'a')).toHaveLength(0);
    });

    it('returns false for an unknown id', () => {
      expect(watchesDb.remove(db, 'nope')).toBe(false);
    });
  });

  describe('removeForTerminal', () => {
    it('removes rows where the terminal is the watcher', () => {
      watchesDb.create(db, { watcherTerminalId: 'a', targetTerminalId: 'b', criteria: 'idle' });
      watchesDb.removeForTerminal(db, 'a');
      expect(watchesDb.listByWatcher(db, 'a')).toHaveLength(0);
      expect(watchesDb.listByTarget(db, 'b')).toHaveLength(0);
    });

    it('removes rows where the terminal is the target', () => {
      watchesDb.create(db, { watcherTerminalId: 'a', targetTerminalId: 'b', criteria: 'idle' });
      watchesDb.removeForTerminal(db, 'b');
      expect(watchesDb.listByWatcher(db, 'a')).toHaveLength(0);
      expect(watchesDb.listByTarget(db, 'b')).toHaveLength(0);
    });

    it('does not touch unrelated watches', () => {
      watchesDb.create(db, { watcherTerminalId: 'a', targetTerminalId: 'b', criteria: 'idle' });
      const otherId = watchesDb.create(db, { watcherTerminalId: 'c', targetTerminalId: 'd', criteria: 'idle' });
      watchesDb.removeForTerminal(db, 'a');
      expect(watchesDb.listByWatcher(db, 'c')).toHaveLength(1);
      expect(watchesDb.listByWatcher(db, 'c')[0].id).toBe(otherId);
    });
  });

  describe('countByWatcher', () => {
    it('counts live watches for a watcher', () => {
      watchesDb.create(db, { watcherTerminalId: 'a', targetTerminalId: 'b', criteria: 'idle' });
      watchesDb.create(db, { watcherTerminalId: 'a', targetTerminalId: 'c', criteria: 'error' });
      watchesDb.create(db, { watcherTerminalId: 'z', targetTerminalId: 'c', criteria: 'error' });
      expect(watchesDb.countByWatcher(db, 'a')).toBe(2);
      expect(watchesDb.countByWatcher(db, 'z')).toBe(1);
    });

    it('excludes fired once=1 watches from the count', () => {
      const id = watchesDb.create(db, { watcherTerminalId: 'a', targetTerminalId: 'b', criteria: 'idle', once: true });
      watchesDb.create(db, { watcherTerminalId: 'a', targetTerminalId: 'c', criteria: 'idle' });
      expect(watchesDb.countByWatcher(db, 'a')).toBe(2);
      watchesDb.markFired(db, id);
      expect(watchesDb.countByWatcher(db, 'a')).toBe(1);
    });

    it('returns 0 for a watcher with no watches', () => {
      expect(watchesDb.countByWatcher(db, 'nobody')).toBe(0);
    });
  });
});
