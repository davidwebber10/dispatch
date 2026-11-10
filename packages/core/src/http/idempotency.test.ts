import { describe, it, expect } from 'vitest';
import { createIdempotencyCache } from './idempotency.js';

const MIN = 60_000;

describe('idempotency cache', () => {
  it('the same key returns the first response', () => {
    const cache = createIdempotencyCache();
    expect(cache.seen('t1', 'k1')).toBeNull();
    cache.remember('t1', 'k1', { status: 204 });
    expect(cache.seen('t1', 'k1')).toEqual({ status: 204 });
    // A later remember for the same key does not replace the first response.
    cache.remember('t1', 'k1', { status: 200, body: { handled: 'settings' } });
    expect(cache.seen('t1', 'k1')).toEqual({ status: 204 });
  });

  it('another scope is independent', () => {
    const cache = createIdempotencyCache();
    cache.remember('t1', 'k1', { status: 204 });
    expect(cache.seen('t2', 'k1')).toBeNull();
    cache.remember('t2', 'k1', { status: 200, body: { handled: 'settings' } });
    expect(cache.seen('t1', 'k1')).toEqual({ status: 204 });
    expect(cache.seen('t2', 'k1')).toEqual({ status: 200, body: { handled: 'settings' } });
  });

  it('a key expires after the TTL', () => {
    let now = 1_000;
    const cache = createIdempotencyCache({ now: () => now });
    cache.remember('t1', 'k1', { status: 204 });
    now += 10 * MIN - 1;
    expect(cache.seen('t1', 'k1')).toEqual({ status: 204 });
    now += 2;
    expect(cache.seen('t1', 'k1')).toBeNull();
    // An expired key can be used again.
    expect(cache.begin('t1', 'k1')).toBe(true);
  });

  it('the oldest key is evicted at the limit', () => {
    const cache = createIdempotencyCache({ max: 3 });
    for (const k of ['a', 'b', 'c']) cache.remember('t1', k, { status: 204 });
    expect(cache.seen('t1', 'a')).not.toBeNull();
    cache.remember('t1', 'd', { status: 204 });
    expect(cache.seen('t1', 'a')).toBeNull();
    for (const k of ['b', 'c', 'd']) expect(cache.seen('t1', k)).not.toBeNull();
    // The limit is per scope: another scope keeps its own keys.
    cache.remember('t2', 'a', { status: 204 });
    expect(cache.seen('t2', 'a')).not.toBeNull();
  });

  it('the default limit is 500 keys per scope', () => {
    const cache = createIdempotencyCache();
    for (let i = 0; i < 501; i++) cache.remember('t1', `k${i}`, { status: 204 });
    expect(cache.seen('t1', 'k0')).toBeNull();
    expect(cache.seen('t1', 'k1')).not.toBeNull();
    expect(cache.seen('t1', 'k500')).not.toBeNull();
  });

  it('begin is true once while a request is in flight, and again after release', () => {
    const cache = createIdempotencyCache();
    expect(cache.begin('t1', 'k1')).toBe(true);
    expect(cache.begin('t1', 'k1')).toBe(false); // the first is still in flight
    expect(cache.begin('t2', 'k1')).toBe(true); // another scope
    cache.release('t1', 'k1'); // the first failed: nothing was delivered, so a retry may run
    expect(cache.begin('t1', 'k1')).toBe(true);
  });

  it('remember ends the flight; begin is false for a remembered key', () => {
    const cache = createIdempotencyCache();
    expect(cache.begin('t1', 'k1')).toBe(true);
    cache.remember('t1', 'k1', { status: 204 });
    expect(cache.seen('t1', 'k1')).toEqual({ status: 204 });
    expect(cache.begin('t1', 'k1')).toBe(false);
  });

  it('a flight that never ends does not block its key for ever', () => {
    let now = 0;
    const cache = createIdempotencyCache({ now: () => now });
    expect(cache.begin('t1', 'k1')).toBe(true);
    now += 10 * MIN + 1;
    expect(cache.begin('t1', 'k1')).toBe(true);
  });

  it('a scope with no key left is dropped', () => {
    let now = 0;
    const cache = createIdempotencyCache({ now: () => now });
    cache.remember('t1', 'k1', { status: 204 });
    expect(cache.scopes()).toBe(1);
    now += 10 * MIN + 1;
    cache.remember('t2', 'k1', { status: 204 }); // a write sweeps the expired scopes
    expect(cache.scopes()).toBe(1);
  });
});

// ---- W3-D: durable keys (the message journal keeps them) ----
import { afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import { MessageJournal } from '../journal/journal.js';
import { journalIdempotencyStore } from '../journal/idempotency.js';
import { setDurableIdempotencyStore } from './idempotency.js';

describe('idempotency cache with a durable store', () => {
  afterEach(() => setDurableIdempotencyStore(null));
  const user = (text: string) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
  function open() {
    const db = new Database(':memory:');
    initSchema(db);
    return db;
  }

  it('a key is refused after a restart: a new cache on the same database knows it', () => {
    const db = open();
    const journal = new MessageJournal(db);
    const first = createIdempotencyCache({ durable: journalIdempotencyStore(journal) });
    expect(first.begin('t1', 'k1')).toBe(true);
    journal.append('t1', { kind: 'user', payload: user('hello') }); // the delivery: the manager's echo is journaled
    first.remember('t1', 'k1', { status: 204 });
    expect(journal.findKey('t1', 'k1')).toMatchObject({ seq: 1, kind: 'user' }); // the key is on the user item

    // The daemon starts again: a new cache and a new journal instance, the same database.
    const second = createIdempotencyCache({ durable: journalIdempotencyStore(new MessageJournal(db)) });
    expect(second.seen('t1', 'k1')).toEqual({ status: 204 });
    expect(second.begin('t1', 'k1')).toBe(false);
    expect(second.seen('t1', 'other')).toBeNull();
    expect(second.seen('t2', 'k1')).toBeNull(); // another thread
  });

  it('the key goes on the user item of ITS request, not on an older one', () => {
    const journal = new MessageJournal(open());
    const cache = createIdempotencyCache({ durable: journalIdempotencyStore(journal) });
    journal.append('t1', { kind: 'user', payload: user('older, no key') });
    cache.begin('t1', 'k1');
    journal.append('t1', { kind: 'user', payload: user('mine') });
    cache.remember('t1', 'k1', { status: 204 });
    expect(journal.findKey('t1', 'k1')?.seq).toBe(2);
  });

  it('a response with a body, or a request that journaled no user item, is kept as its own record', () => {
    const db = open();
    const journal = new MessageJournal(db);
    const cache = createIdempotencyCache({ durable: journalIdempotencyStore(journal) });
    cache.begin('t1', 'slash');
    cache.remember('t1', 'slash', { status: 200, body: { handled: 'settings' } });
    cache.begin('pty', 'k');
    cache.remember('pty', 'k', { status: 204 }); // a CLI thread: no journal item for the message
    const again = createIdempotencyCache({ durable: journalIdempotencyStore(new MessageJournal(db)) });
    expect(again.seen('t1', 'slash')).toEqual({ status: 200, body: { handled: 'settings' } });
    expect(again.seen('pty', 'k')).toEqual({ status: 204 });
  });

  it('a failed request keeps nothing durable, so its key can run again after a restart', () => {
    const db = open();
    const cache = createIdempotencyCache({ durable: journalIdempotencyStore(new MessageJournal(db)) });
    cache.begin('t1', 'k1');
    cache.release('t1', 'k1');
    const again = createIdempotencyCache({ durable: journalIdempotencyStore(new MessageJournal(db)) });
    expect(again.seen('t1', 'k1')).toBeNull();
    expect(again.begin('t1', 'k1')).toBe(true);
  });

  it('a durable key does not expire with the memory TTL', () => {
    let now = 1_000;
    const journal = new MessageJournal(open());
    const cache = createIdempotencyCache({ now: () => now, durable: journalIdempotencyStore(journal) });
    cache.begin('t1', 'k1');
    cache.remember('t1', 'k1', { status: 204 });
    now += 60 * MIN;
    expect(cache.seen('t1', 'k1')).toEqual({ status: 204 });
  });

  it('a cache made with no option uses the store the daemon set, and none when it set none', () => {
    const db = open();
    setDurableIdempotencyStore(journalIdempotencyStore(new MessageJournal(db)));
    const cache = createIdempotencyCache();
    cache.begin('t1', 'k1');
    cache.remember('t1', 'k1', { status: 204 });
    expect(createIdempotencyCache().seen('t1', 'k1')).toEqual({ status: 204 });
    setDurableIdempotencyStore(null);
    expect(createIdempotencyCache().seen('t1', 'k1')).toBeNull();
  });

  it('a store that throws does not break the request', () => {
    const boom = () => { throw new Error('db gone'); };
    const cache = createIdempotencyCache({ durable: { find: boom, mark: boom, save: boom } });
    expect(cache.seen('t1', 'k1')).toBeNull();
    expect(cache.begin('t1', 'k1')).toBe(true);
    expect(() => cache.remember('t1', 'k1', { status: 204 })).not.toThrow();
    expect(cache.seen('t1', 'k1')).toEqual({ status: 204 });
  });
});
