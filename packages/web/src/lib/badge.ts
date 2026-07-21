/** Durable app-icon badge counter for thread alerts.
 *
 *  The service worker increments this on each push it shows, and the app clears it
 *  when it comes to the foreground — the same "N unread, cleared when you open it"
 *  behaviour a native app's icon badge has.
 *
 *  The count lives in the Cache API, not memory, because the service worker is
 *  killed between push events: an in-memory counter would reset to 1 on every
 *  alert. Cache is one of the few stores reachable from both the worker and the
 *  page and it survives the worker dying.
 *
 *  Mirrored by public/sw.js (which cannot import this bundled module) — the
 *  cache name, key, and increment must be changed in both places together.
 */
export const BADGE_CACHE = 'dispatch-badge';
export const BADGE_URL = '/__badge-count';

async function readCount(): Promise<number> {
  try {
    const cache = await caches.open(BADGE_CACHE);
    const hit = await cache.match(BADGE_URL);
    if (!hit) return 0;
    const n = Number(await hit.text());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Increment the unread-alert count and paint it on the app icon. Returns the new
 *  count, or undefined on an insecure origin with no Cache API (no SW, no badge). */
export async function bumpBadge(): Promise<number | undefined> {
  if (typeof caches === 'undefined') return undefined;
  const count = (await readCount()) + 1;
  try {
    const cache = await caches.open(BADGE_CACHE);
    await cache.put(BADGE_URL, new Response(String(count)));
  } catch {
    /* best effort — worst case the count is under-reported, never wrong-app */
  }
  try {
    if (typeof navigator !== 'undefined' && 'setAppBadge' in navigator) {
      await (navigator as Navigator & { setAppBadge(n?: number): Promise<void> }).setAppBadge(count);
    }
  } catch {
    /* Badging API unsupported (older iOS / not installed) — the count is still tracked */
  }
  return count;
}

/** Clear the icon badge and reset the counter. Called when the app is foregrounded:
 *  opening the app is the human acknowledging the alerts, exactly like a native app. */
export async function clearBadge(): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && 'clearAppBadge' in navigator) {
      await (navigator as Navigator & { clearAppBadge(): Promise<void> }).clearAppBadge();
    }
  } catch {
    /* unsupported — nothing to clear */
  }
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(BADGE_CACHE);
    await cache.delete(BADGE_URL);
  } catch {
    /* best effort */
  }
}
