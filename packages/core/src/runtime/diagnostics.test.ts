import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { logLifecycle } from './diagnostics.js';

describe('logLifecycle trim (W1-E)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
    terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 'a' });
    terminalsDb.create(db, { id: 't2', sessionId: 's1', type: 'claude-code', label: 'b' });
  });
  afterEach(() => db.close());

  const count = (id: string) => (db.prepare('SELECT COUNT(*) AS n FROM lifecycle_events WHERE terminal_id = ?').get(id) as { n: number }).n;
  const log = (id: string, n: number, type = 'status.working') => {
    for (let i = 0; i < n; i++) logLifecycle(db, { terminalId: id, type, observedAt: new Date(1_700_000_000_000 + i).toISOString() }, 'applied');
  };

  test('the table holds at most 200 + 50 rows per terminal', () => {
    let max = 0;
    for (let i = 0; i < 1000; i++) {
      log('t1', 1);
      max = Math.max(max, count('t1'));
    }
    expect(max).toBeLessThanOrEqual(250);
    expect(max).toBeGreaterThan(200); // the trim does not run on every insert
    // A second terminal has its own count and its own rows.
    log('t2', 120);
    expect(count('t2')).toBe(120);
    expect(count('t1')).toBeLessThanOrEqual(250);
  });

  test('the trim runs once per 50 inserts', () => {
    log('t1', 249);
    expect(count('t1')).toBe(249);  // 49 rows over the cap: no trim at insert 201..249
    log('t1', 1);                   // insert 250: the trim runs
    expect(count('t1')).toBe(200);
    log('t1', 49);
    expect(count('t1')).toBe(249);
    log('t1', 1);                   // insert 300
    expect(count('t1')).toBe(200);
  });

  test('the trim keeps the newest 200 rows', () => {
    log('t1', 250);
    const ids = (db.prepare('SELECT id FROM lifecycle_events WHERE terminal_id = ? ORDER BY id').all('t1') as { id: number }[]).map((r) => r.id);
    expect(ids[0]).toBe(51);
    expect(ids[ids.length - 1]).toBe(250);
  });

  test('a row keeps the status of the terminal and the event fields', () => {
    terminalsDb.updateStatus(db, 't1', 'working');
    logLifecycle(db, { terminalId: 't1', type: 'turn.started', observedAt: '2026-11-09T00:00:00.000Z', generation: 'g1', turnId: 'turn-1', eventId: 'e1' }, 'applied');
    expect(db.prepare('SELECT terminal_id,event_type,generation,turn_id,event_id,observed_at,status,disposition FROM lifecycle_events').get()).toEqual({
      terminal_id: 't1', event_type: 'turn.started', generation: 'g1', turn_id: 'turn-1', event_id: 'e1',
      observed_at: '2026-11-09T00:00:00.000Z', status: 'working', disposition: 'applied',
    });
  });

  test('two databases do not share a count', () => {
    const other = new Database(':memory:');
    initSchema(other);
    log('t1', 49);
    for (let i = 0; i < 201; i++) logLifecycle(other, { terminalId: 't1', type: 'x', observedAt: 'now' }, 'applied');
    // Insert 50 on `db` trims `db` only; `other` has 201 inserts of its own and was trimmed at 50, 100, 150 and 200 (nothing to remove).
    log('t1', 1);
    expect(count('t1')).toBe(50);
    expect((other.prepare('SELECT COUNT(*) AS n FROM lifecycle_events').get() as { n: number }).n).toBe(201);
    other.close();
  });
});
