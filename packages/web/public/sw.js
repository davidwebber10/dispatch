// Dispatch service worker — installable PWA shell.
// Deliberately conservative because the origin sits behind Cloudflare Access:
// API / WebSocket / Access / upload paths are never intercepted, and the HTML
// shell is revalidated over the network so an expired session re-authenticates.
const VERSION = 'dispatch-v6';
const CACHE = `dispatch-${VERSION}`;
// Durable hand-off for a notification tap. Kept OUT of the versioned shell cache
// so an activate sweep can't discard a tap that landed mid-update.
// Mirrored by src/lib/pendingIntent.ts — change both together.
const INTENT_CACHE = 'dispatch-intent';
const INTENT_URL = '/__pending-thread';
// Durable unread-alert count painted on the app icon. The SW is killed between
// pushes, so an in-memory counter would reset to 1 every alert — it lives in the
// Cache instead, likewise exempt from the activate sweep. Mirrored by
// src/lib/badge.ts (the app clears it on foreground) — change both together.
const BADGE_CACHE = 'dispatch-badge';
const BADGE_URL = '/__badge-count';

// Increment the unread-alert count and paint it on the app icon (iOS 16.4+ PWA).
async function bumpBadge() {
  if (typeof caches === 'undefined') return;
  let count = 0;
  try {
    const cache = await caches.open(BADGE_CACHE);
    const hit = await cache.match(BADGE_URL);
    if (hit) { const n = Number(await hit.text()); if (Number.isFinite(n) && n > 0) count = n; }
    count += 1;
    await cache.put(BADGE_URL, new Response(String(count)));
  } catch { count = count || 1; }
  try {
    if (self.navigator && 'setAppBadge' in self.navigator) await self.navigator.setAppBadge(count);
  } catch { /* Badging API unsupported — the count is still tracked */ }
}

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE && k !== INTENT_CACHE && k !== BADGE_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never touch dynamic / auth-gated paths — let the browser handle them directly.
  if (/^\/(api|ws|cdn-cgi|inbox)(\/|$)/.test(url.pathname)) return;

  // Immutable, content-hashed build assets and icons: cache-first.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  // App-shell navigations: network-first (so Access auth is always revalidated),
  // falling back to the cached shell only when offline.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && !res.redirected) {
          const cache = await caches.open(CACHE);
          cache.put('/', res.clone());
        }
        return res;
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match('/')) || Response.error();
      }
    })());
  }
});

// --- Web push: show a notification when a thread finishes / needs input ---
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = {}; }
  const title = d.title || 'Dispatch';
  event.waitUntil((async () => {
    await self.registration.showNotification(title, {
      body: d.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: d.terminalId || undefined,   // coalesce repeated pings per thread
      data: { terminalId: d.terminalId || null, sessionId: d.sessionId || null },
    });
    // Bump the app-icon count too, so the home screen shows how many alerts are waiting.
    await bumpBadge();
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { terminalId, sessionId } = event.notification.data || {};
  event.waitUntil((async () => {
    // Park the target BEFORE touching any client. postMessage is fire-and-forget:
    // if the page isn't listening at this instant the intent is discarded, not
    // queued — and on iOS a backgrounded PWA is frozen, so that is the norm rather
    // than a rare race. The app drains this on mount and on every foreground.
    if (terminalId && sessionId) {
      try {
        const cache = await caches.open(INTENT_CACHE);
        await cache.put(INTENT_URL, new Response(JSON.stringify({ terminalId, sessionId, ts: Date.now() })));
      } catch { /* the message / deep-link paths below still cover a live client */ }
    }
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = all.find((c) => c.url.startsWith(self.location.origin));
    if (existing) {
      await existing.focus();
      // Fast path for a client that IS awake and listening — it navigates without
      // waiting for the visibilitychange drain. Harmless if it lands nowhere.
      if (terminalId && sessionId) existing.postMessage({ type: 'open-thread', terminalId, sessionId });
      return;
    }
    // Cold path: the mobile shell restores /p/<s>/t/<t> natively; desktop parses it at boot.
    await self.clients.openWindow(terminalId && sessionId ? `/p/${sessionId}/t/${terminalId}` : '/');
  })());
});
