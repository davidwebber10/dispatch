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
