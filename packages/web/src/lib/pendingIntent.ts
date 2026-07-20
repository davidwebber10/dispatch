/** Durable hand-off for the "open this thread" intent raised by a notification tap.
 *
 *  The service worker cannot rely on `client.postMessage()` alone. iOS freezes a
 *  backgrounded PWA, so at tap time the page is *resumable but not listening* —
 *  and a message posted with no listener attached is dropped on the floor, not
 *  queued for a late subscriber. Worse, `clients.matchAll()` still reports that
 *  frozen page, so the SW takes the focus-and-post branch and never falls through
 *  to `openWindow()` with the deep link that would have worked.
 *
 *  So the SW parks the target here first and the app *pulls* it — on mount and on
 *  every foreground — instead of depending on being awake at the right instant.
 *  The Cache API is the store because it is one of the few things reachable from
 *  both the worker and the page, and it survives the worker being killed.
 */
export const INTENT_CACHE = 'dispatch-intent';
export const INTENT_URL = '/__pending-thread';

export type ThreadIntent = { sessionId: string; terminalId: string };

/** Park a tap target. Mirrors what sw.js writes, and exists so tests exercise the
 *  real read path rather than a hand-rolled fixture. */
export async function writePendingIntent(intent: ThreadIntent): Promise<void> {
  if (typeof caches === 'undefined') return; // insecure origin — alerts are hidden anyway
  try {
    const cache = await caches.open(INTENT_CACHE);
    await cache.put(INTENT_URL, new Response(JSON.stringify({ ...intent, ts: Date.now() })));
  } catch { /* best effort: postMessage / deep-link URL still cover the live cases */ }
}

/** Read *and clear* the parked intent.
 *
 *  One-shot by design: a single tap must navigate exactly once, or the intent
 *  would re-fire on every foreground. Anything older than `maxAgeMs` is dropped
 *  (but still cleared) so a tap the user abandoned can't yank them out of a
 *  thread they opened by hand ten minutes later.
 */
export async function readPendingIntent(maxAgeMs = 60_000): Promise<ThreadIntent | null> {
  if (typeof caches === 'undefined') return null;
  try {
    const cache = await caches.open(INTENT_CACHE);
    const hit = await cache.match(INTENT_URL);
    if (!hit) return null;
    await cache.delete(INTENT_URL);
    const d = (await hit.json()) as Partial<ThreadIntent> & { ts?: number };
    if (!d?.sessionId || !d?.terminalId) return null;
    if (typeof d.ts !== 'number' || Date.now() - d.ts > maxAgeMs) return null;
    return { sessionId: d.sessionId, terminalId: d.terminalId };
  } catch {
    return null;
  }
}
