import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bumpBadge, clearBadge, BADGE_CACHE, BADGE_URL } from './badge';

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

/** Install spies for the Badging API, which jsdom's navigator does not implement. */
function installFakeBadge(): { set: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> } {
  const set = vi.fn(async () => {});
  const clear = vi.fn(async () => {});
  Object.defineProperty(navigator, 'setAppBadge', { value: set, configurable: true, writable: true });
  Object.defineProperty(navigator, 'clearAppBadge', { value: clear, configurable: true, writable: true });
  return { set, clear };
}
function removeFakeBadge(): void {
  delete (navigator as unknown as { setAppBadge?: unknown }).setAppBadge;
  delete (navigator as unknown as { clearAppBadge?: unknown }).clearAppBadge;
}

describe('app-icon badge', () => {
  afterEach(() => {
    delete (globalThis as unknown as { caches?: unknown }).caches;
    removeFakeBadge();
    vi.restoreAllMocks();
  });

  it('counts up across successive alerts and sets the badge to each running total', async () => {
    installFakeCaches();
    const { set } = installFakeBadge();
    expect(await bumpBadge()).toBe(1);
    expect(await bumpBadge()).toBe(2);
    expect(await bumpBadge()).toBe(3);
    expect(set).toHaveBeenNthCalledWith(1, 1);
    expect(set).toHaveBeenNthCalledWith(2, 2);
    expect(set).toHaveBeenNthCalledWith(3, 3);
  });

  it('persists the count so it survives the service worker being killed between pushes', async () => {
    const store = installFakeCaches();
    installFakeBadge();
    await bumpBadge();
    await bumpBadge();
    const hit = store.get(BADGE_CACHE)?.get(BADGE_URL);
    expect(Number(await hit!.text())).toBe(2);
  });

  it('clearBadge clears the icon and resets the counter so the next alert starts at 1', async () => {
    installFakeCaches();
    const { set, clear } = installFakeBadge();
    await bumpBadge();
    await bumpBadge();
    await clearBadge();
    expect(clear).toHaveBeenCalledOnce();
    expect(await bumpBadge()).toBe(1);
  });

  it('is inert (no throw) on a browser without the Badging API', async () => {
    installFakeCaches();
    // no installFakeBadge() — navigator.setAppBadge is undefined
    await expect(bumpBadge()).resolves.toBe(1); // still tracks the count, just cannot paint it
    await expect(clearBadge()).resolves.toBeUndefined();
  });

  it('is inert on an insecure origin with no Cache API', async () => {
    installFakeBadge();
    // no installFakeCaches() — caches is undefined
    await expect(bumpBadge()).resolves.toBeUndefined();
    await expect(clearBadge()).resolves.toBeUndefined();
  });
});
