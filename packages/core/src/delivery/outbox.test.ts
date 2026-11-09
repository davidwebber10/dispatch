// The delivery outbox (engineering program W2-C): a message for a thread is written to the
// database first, then delivered. A message that cannot be delivered now waits for an event.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import { DeliveryOutbox, type DeliverResult, type OutboxKind } from './outbox.js';

function memoryDb(): Database.Database {
  const db = new Database(':memory:');
  initSchema(db);
  return db;
}

/** A target whose liveness the test controls; records every body it got. */
function harness(db = memoryDb()) {
  const alive = new Set<string>();
  const gone = new Set<string>();
  const got: { to: string; body: string; kind: OutboxKind }[] = [];
  let fail: Error | null = null;
  const deliver = vi.fn((to: string, body: string, kind: OutboxKind): DeliverResult => {
    if (fail) throw fail;
    if (gone.has(to)) return 'gone';
    if (!alive.has(to)) return 'not-alive';
    got.push({ to, body, kind });
    return 'delivered';
  });
  const outbox = new DeliveryOutbox({ db, deliver });
  return { db, outbox, alive, gone, got, deliver, failWith: (e: Error | null) => { fail = e; } };
}

const notice = (n: number, targetId = 'coord') => ({ targetId, sourceId: 'worker', kind: 'notice' as const, body: `notice ${n}`, dedupKey: `notice:worker:finished:g1:${n}` });

afterEach(() => { vi.useRealTimers(); });

describe('DeliveryOutbox', () => {
  it('enqueue delivers at once when the target is alive and marks the row delivered', () => {
    const h = harness();
    h.alive.add('coord');
    const r = h.outbox.enqueue(notice(1));
    expect(r).toMatchObject({ state: 'delivered', duplicate: false });
    expect(h.got).toEqual([{ to: 'coord', body: 'notice 1', kind: 'notice' }]);
    const [row] = h.outbox.list({ terminalId: 'coord' });
    expect(row).toMatchObject({ id: r.id, state: 'delivered', target_terminal_id: 'coord', source_terminal_id: 'worker', kind: 'notice' });
    expect(row.delivered_at).toBeTruthy();
  });

  it('enqueue keeps the row pending when the target is not alive', () => {
    const h = harness();
    const r = h.outbox.enqueue(notice(1));
    expect(r).toMatchObject({ state: 'pending', duplicate: false });
    expect(h.got).toHaveLength(0);
    expect(h.outbox.list({ state: 'pending' })).toHaveLength(1);
    // A target that is not running is not a failed attempt: the row waits, however long.
    expect(h.outbox.list({})[0].attempts).toBe(0);
  });

  it('flush delivers the pending rows in order', () => {
    const h = harness();
    h.outbox.enqueue(notice(1));
    h.outbox.enqueue(notice(2));
    h.outbox.enqueue(notice(3));
    h.outbox.enqueue(notice(9, 'other'));
    h.alive.add('coord');
    expect(h.outbox.flush('coord')).toBe(3);
    expect(h.got.map((g) => g.body)).toEqual(['notice 1', 'notice 2', 'notice 3']);
    expect(h.outbox.list({ terminalId: 'coord', state: 'pending' })).toHaveLength(0);
    expect(h.outbox.list({ terminalId: 'other', state: 'pending' })).toHaveLength(1);
    expect(h.outbox.flush('coord')).toBe(0); // nothing is delivered twice
    expect(h.got).toHaveLength(3);
  });

  it('a new row does not overtake an older pending row of the same target', () => {
    const h = harness();
    h.outbox.enqueue(notice(1));
    h.alive.add('coord');
    h.outbox.enqueue(notice(2));
    expect(h.got.map((g) => g.body)).toEqual(['notice 1', 'notice 2']);
  });

  it('the same dedup key enqueues once and reports duplicate', () => {
    const h = harness();
    h.alive.add('coord');
    const first = h.outbox.enqueue(notice(1));
    const second = h.outbox.enqueue({ ...notice(1), body: 'the same event, sent again' });
    expect(second).toEqual({ id: first.id, state: 'delivered', duplicate: true });
    expect(h.got).toHaveLength(1);
    expect(h.outbox.list({})).toHaveLength(1);
  });

  it('a duplicate of a pending row is not a second delivery attempt', () => {
    const h = harness();
    h.outbox.enqueue(notice(1));
    const calls = h.deliver.mock.calls.length;
    expect(h.outbox.enqueue(notice(1))).toMatchObject({ state: 'pending', duplicate: true });
    expect(h.deliver.mock.calls.length).toBe(calls);
  });

  it('a row is dropped after five failed attempts with the last error saved', () => {
    const h = harness();
    h.failWith(new Error('transport exploded'));
    const r = h.outbox.enqueue(notice(1)); // attempt 1
    expect(r.state).toBe('pending');
    for (let i = 2; i <= 4; i++) {
      h.outbox.flush('coord');
      expect(h.outbox.list({})[0]).toMatchObject({ state: 'pending', attempts: i });
    }
    h.failWith(new Error('still broken'));
    h.outbox.flush('coord'); // attempt 5
    expect(h.outbox.list({})[0]).toMatchObject({ state: 'dropped', attempts: 5, last_error: 'still broken' });
    h.failWith(null);
    h.alive.add('coord');
    expect(h.outbox.flush('coord')).toBe(0); // a dropped row is never delivered
    expect(h.got).toHaveLength(0);
  });

  it('a throw in deliver never leaves enqueue or flush', () => {
    const h = harness();
    h.failWith(new Error('boom'));
    expect(() => h.outbox.enqueue(notice(1))).not.toThrow();
    expect(() => h.outbox.flush('coord')).not.toThrow();
  });

  it('a target that is gone drops the row with a reason', () => {
    const h = harness();
    h.gone.add('coord');
    const dropped: string[] = [];
    h.outbox.onDropped((row) => dropped.push(`${row.id}:${row.last_error}`));
    const r = h.outbox.enqueue(notice(1));
    expect(r.state).toBe('dropped');
    expect(h.outbox.list({})[0]).toMatchObject({ state: 'dropped', last_error: 'the target is archived or removed' });
    expect(dropped).toEqual([`${r.id}:the target is archived or removed`]);
  });

  it('rows survive a new DeliveryOutbox on the same database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-restart-'));
    try {
      const file = path.join(dir, 'dispatch.db');
      const open = () => { const db = new Database(file); db.pragma('journal_mode = WAL'); initSchema(db); return db; };
      const first = harness(open());
      first.outbox.enqueue(notice(1));
      first.outbox.enqueue(notice(2));
      // No close: a kill -9 does not close anything either.
      const second = harness(open());
      expect(second.outbox.list({ state: 'pending' }).map((r) => r.body)).toEqual(['notice 2', 'notice 1']); // list is newest first
      second.alive.add('coord');
      expect(second.outbox.flushAll()).toBe(2);
      expect(second.got.map((g) => g.body)).toEqual(['notice 1', 'notice 2']);
      // The dedup key survives too: the event that made row 1 cannot make a second row after the restart.
      expect(second.outbox.enqueue(notice(1))).toMatchObject({ duplicate: true, state: 'delivered' });
      expect(second.got).toHaveLength(2);
      first.db.close(); second.db.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('drop marks every pending row of an archived target', () => {
    const h = harness();
    h.outbox.enqueue(notice(1));
    h.outbox.enqueue(notice(2));
    h.outbox.enqueue(notice(3, 'other'));
    expect(h.outbox.drop('coord', 'the thread was archived')).toBe(2);
    const rows = h.outbox.list({ terminalId: 'coord' });
    expect(rows.every((r) => r.state === 'dropped' && r.last_error === 'the thread was archived')).toBe(true);
    expect(h.outbox.list({ terminalId: 'other', state: 'pending' })).toHaveLength(1);
    h.alive.add('coord');
    expect(h.outbox.flush('coord')).toBe(0);
  });

  it('no timer is created', () => {
    vi.useFakeTimers();
    const h = harness();
    h.outbox.enqueue(notice(1));
    h.failWith(new Error('boom'));
    h.outbox.enqueue(notice(2));
    h.outbox.flush('coord');
    h.outbox.flushAll();
    h.outbox.drop('coord', 'x');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('onDelivered runs once for each delivered row, at once or after a flush', () => {
    const h = harness();
    const seen: number[] = [];
    h.outbox.onDelivered((row) => seen.push(row.id));
    h.outbox.onDelivered(() => { throw new Error('a listener error is contained'); });
    const a = h.outbox.enqueue(notice(1));
    h.alive.add('coord');
    const b = h.outbox.enqueue(notice(2));
    expect(seen).toEqual([a.id, b.id]);
  });

  it('a delivery that starts the target does not deliver the row a second time', () => {
    // The real case: deliver revives the process, the process start event flushes the same target.
    const db = memoryDb();
    const got: string[] = [];
    const outbox: DeliveryOutbox = new DeliveryOutbox({
      db,
      deliver: (to, body) => { outbox.flush(to); got.push(body); return 'delivered'; },
    });
    outbox.enqueue(notice(1));
    expect(got).toEqual(['notice 1']);
    expect(outbox.list({})[0]).toMatchObject({ state: 'delivered', attempts: 0 });
  });

  it('a row enqueued for a target during its own delivery is delivered after it, once', () => {
    const db = memoryDb();
    const got: string[] = [];
    const outbox: DeliveryOutbox = new DeliveryOutbox({
      db,
      deliver: (_to, body) => {
        if (body === 'notice 1') outbox.enqueue(notice(2));
        got.push(body);
        return 'delivered';
      },
    });
    outbox.enqueue(notice(1));
    expect(got).toEqual(['notice 1', 'notice 2']);
    expect(outbox.list({ state: 'pending' })).toHaveLength(0);
  });

  it('immediateOnly drops a row that could not be delivered in the same call', () => {
    const h = harness();
    const r = h.outbox.enqueue({ ...notice(1), immediateOnly: 'the question went to the user instead' });
    expect(r.state).toBe('dropped');
    expect(h.outbox.list({})[0]).toMatchObject({ state: 'dropped', last_error: 'the question went to the user instead' });
    h.alive.add('coord');
    expect(h.outbox.flush('coord')).toBe(0);
  });

  it('list filters by thread and state, newest first, with a limit', () => {
    const h = harness();
    h.alive.add('coord');
    h.outbox.enqueue(notice(1));
    h.outbox.enqueue(notice(2));
    h.outbox.enqueue(notice(3, 'other'));
    expect(h.outbox.list({ terminalId: 'coord' }).map((r) => r.body)).toEqual(['notice 2', 'notice 1']);
    expect(h.outbox.list({ state: 'pending' }).map((r) => r.body)).toEqual(['notice 3']);
    expect(h.outbox.list({ limit: 1 })).toHaveLength(1);
  });

  it('prune removes old delivered and dropped rows and keeps every pending row', () => {
    let now = Date.parse('2026-11-01T00:00:00Z');
    const db = memoryDb();
    const alive = new Set<string>(['coord']);
    const outbox = new DeliveryOutbox({ db, now: () => now, deliver: (to) => (alive.has(to) ? 'delivered' : 'not-alive') });
    outbox.enqueue(notice(1));
    outbox.enqueue(notice(2, 'stopped'));
    now += 10 * 24 * 3600_000;
    outbox.enqueue(notice(3));
    expect(outbox.prune(7 * 24 * 3600_000)).toBe(1);
    expect(outbox.list({}).map((r) => r.body).sort()).toEqual(['notice 2', 'notice 3']);
  });
});
