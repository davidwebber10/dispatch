import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readPendingIntent, writePendingIntent, INTENT_CACHE, INTENT_URL } from './pendingIntent';

/** Minimal Cache API stand-in — jsdom ships no `caches`. */
function installFakeCaches(): Map<string, Map<string, Response>> {
  const store = new Map<string, Map<string, Response>>();
  (globalThis as unknown as { caches: unknown }).caches = {
    open: async (name: string) => {
      if (!store.has(name)) store.set(name, new Map());
      const c = store.get(name)!;
      return {
        put: async (k: string, v: Response) => { c.set(k, v); },
        match: async (k: string) => c.get(k),
        delete: async (k: string) => c.delete(k),
      };
    },
  };
  return store;
}

describe('readPendingIntent', () => {
  beforeEach(() => { installFakeCaches(); });
  afterEach(() => { delete (globalThis as unknown as { caches?: unknown }).caches; vi.useRealTimers(); });

  it('returns nothing when no notification tap has been parked', async () => {
    expect(await readPendingIntent()).toBeNull();
  });

  it('recovers the intent a service worker parked before the page was listening', async () => {
    // The exact case that broke: the SW writes while the frozen page has no
    // message listener attached, so postMessage would have been dropped.
    await writePendingIntent({ sessionId: 's-1', terminalId: 't-1' });
    expect(await readPendingIntent()).toEqual({ sessionId: 's-1', terminalId: 't-1' });
  });

  it('is one-shot — a single tap must not re-navigate on every foreground', async () => {
    await writePendingIntent({ sessionId: 's-1', terminalId: 't-1' });
    expect(await readPendingIntent()).not.toBeNull();
    expect(await readPendingIntent()).toBeNull();
  });

  it('discards a stale intent rather than yanking the user out of a thread', async () => {
    const store = installFakeCaches();
    store.set(INTENT_CACHE, new Map([[INTENT_URL, new Response(
      JSON.stringify({ sessionId: 's-1', terminalId: 't-1', ts: Date.now() - 10 * 60_000 }),
    )]]));
    expect(await readPendingIntent(60_000)).toBeNull();
  });

  it('clears a stale intent so it cannot fire later', async () => {
    const store = installFakeCaches();
    const c = new Map([[INTENT_URL, new Response(
      JSON.stringify({ sessionId: 's-1', terminalId: 't-1', ts: Date.now() - 10 * 60_000 }),
    )]]);
    store.set(INTENT_CACHE, c);
    await readPendingIntent(60_000);
    expect(c.has(INTENT_URL)).toBe(false);
  });

  it('survives a malformed or half-written entry', async () => {
    const store = installFakeCaches();
    store.set(INTENT_CACHE, new Map([[INTENT_URL, new Response('not json{')]]));
    expect(await readPendingIntent()).toBeNull();
  });

  it('ignores an entry missing its ids', async () => {
    const store = installFakeCaches();
    store.set(INTENT_CACHE, new Map([[INTENT_URL, new Response(
      JSON.stringify({ sessionId: 's-1', ts: Date.now() }),
    )]]));
    expect(await readPendingIntent()).toBeNull();
  });

  it('is inert where the Cache API is absent (insecure origin)', async () => {
    delete (globalThis as unknown as { caches?: unknown }).caches;
    expect(await readPendingIntent()).toBeNull();
    await expect(writePendingIntent({ sessionId: 's', terminalId: 't' })).resolves.toBeUndefined();
  });
});
