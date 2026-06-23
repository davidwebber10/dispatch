// Dispatch service worker — installable PWA shell.
// Deliberately conservative because the origin sits behind Cloudflare Access:
// API / WebSocket / Access / upload paths are never intercepted, and the HTML
// shell is revalidated over the network so an expired session re-authenticates.
const VERSION = 'dispatch-v2';
const CACHE = `dispatch-${VERSION}`;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
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
