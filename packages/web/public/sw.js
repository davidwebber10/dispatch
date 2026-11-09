// Dispatch service worker — installable PWA shell.
// Deliberately conservative because the origin sits behind Cloudflare Access:
// API / WebSocket / Access / upload paths are never intercepted, and the HTML
// shell is revalidated over the network so an expired session re-authenticates.
const VERSION = 'dispatch-v8';
// The saved app shell. Mirrored by src/lib/shellCache.ts — change both together.
const SHELL_URL = '/';
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

// The app's mount point: '/' for a local daemon, '/u/<name>/dispatch/' on a hosted box (DISPATCH_BASE_PATH).
// Every path test below is relative to it, so the worker does the same work under a prefix (W2-H).
const SCOPE = (() => {
  try { const p = new URL(self.registration.scope).pathname; return p.endsWith('/') ? p : p + '/'; } catch { return '/'; }
})();
/** The path inside the app ('/api/x', '/assets/y.js'), or null for an address outside the scope. */
function appPathOf(url) {
  if (url.pathname === SCOPE.slice(0, -1)) return '/';
  return url.pathname.startsWith(SCOPE) ? '/' + url.pathname.slice(SCOPE.length) : null;
}
/** An app path ('/icons/x.png') as a real address under the scope. */
const scoped = (p) => SCOPE + String(p).replace(/^\/+/, '');

// The two small files the first paint waits on (index.html loads theme-boot.js with a blocking script
// tag; the browser reads the manifest at launch). The daemon sends both with max-age=0, so before
// W2-H each launch waited a full round trip on theme-boot.js (three on a new connection) before any
// paint, although the shell and the build files came from this worker at once.
const LAUNCH_FILES = new Set(['/theme-boot.js', '/manifest.webmanifest']);

/** True for an answer that is the file itself: not an error, not a redirect to a sign-in page. */
const good = (res) => !!res && res.ok && !res.redirected;

/** The build files a shell names: its module script, its stylesheets and its preloaded chunks. */
function shellFiles(html) {
  const abs = (href) => { try { return new URL(href, self.registration.scope).href; } catch { return null; } };
  const tags = (re) => [...html.matchAll(re)].map((m) => abs(m[1])).filter(Boolean);
  const entry = tags(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/g)[0] ?? null;
  const rest = [
    ...tags(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g),
    ...tags(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+)"/g),
  ];
  return { entry, all: entry ? [entry, ...rest] : rest };
}

/** Make sure `url` is in the cache. Throws when it is absent and cannot be fetched. */
async function store(cache, url) {
  if (await cache.match(url)) return;
  const res = await fetch(url);
  if (!good(res)) throw new Error(`could not fetch ${url}`);
  await cache.put(url, res);
}

async function tellClients(message) {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of all) c.postMessage(message);
}

/**
 * Fetch the shell and save it. Returns the network answer.
 *
 * A shell that names a new entry script means a new build. Its script and stylesheet are saved FIRST,
 * then the shell, then the page is told (`shell-updated`). So the reload that follows, and the next
 * launch, need no network at all. Before W2-H the page dropped the saved shell and reloaded from the
 * network: a blank screen for three round trips and the whole script download.
 * When a build file cannot be fetched, the old saved shell stays (its files are saved), and no message
 * is sent: the next launch or the page's own check tries again.
 * `announce`: the page asked for this refresh, so it gets the message also when the saved shell was
 * already the new one.
 */
async function refreshShell(request, announce, keep) {
  const res = await fetch(request);
  const cache = await caches.open(CACHE);
  if (!good(res)) { await cache.delete(SHELL_URL); return res; }
  const saved = await cache.match(SHELL_URL);
  const savedEntry = saved ? shellFiles(await saved.text()).entry : null;
  const files = shellFiles(await res.clone().text());
  if (!saved && !announce) {
    // No saved shell yet: the page waits on this answer, so it goes back at once. The shell is saved,
    // and its files are saved after (the page loads them itself in the meantime).
    await cache.put(SHELL_URL, res.clone());
    keep(Promise.all(files.all.map((u) => store(cache, u))).catch(() => {}));
    return res;
  }
  try {
    await Promise.all(files.all.map((u) => store(cache, u)));
  } catch (err) {
    if (announce) throw err;
    return res;
  }
  await cache.put(SHELL_URL, res.clone());
  if (files.entry && (announce || (saved && savedEntry !== files.entry))) await tellClients({ type: 'shell-updated', entry: files.entry });
  return res;
}

/** The chunk files a script names next to itself ("./Name-hash.js", "./Name-hash.css"). */
function chunkRefs(text, base) {
  const out = new Set();
  for (const m of text.matchAll(/["'`]\.\/([A-Za-z0-9_.~-]+\.(?:js|css))["'`]/g)) {
    try { out.add(new URL(m[1], base).href); } catch { /* not an address */ }
  }
  return [...out];
}

/**
 * Save the lazy chunks of the current build (the terminal, the editor, analytics, the phone layout),
 * so the first open of each needs no download. The page asks for this when it is idle. The list
 * comes from the entry script itself: it names every chunk it can import. One file at a time, and a
 * file that is already saved costs nothing.
 */
const WARM_MAX_FILES = 80;
async function warmChunks() {
  const cache = await caches.open(CACHE);
  let shell = await cache.match(SHELL_URL);
  if (!shell) {
    // The first visit: the page loaded before this worker controlled it, so nothing is saved yet.
    // Save the shell now, and the next launch starts from the cache.
    const res = await fetch(new Request(self.registration.scope, { cache: 'no-store' }));
    if (!good(res)) return;
    await cache.put(SHELL_URL, res.clone());
    shell = res;
  }
  const files = shellFiles(await shell.text());
  const entry = files.entry;
  if (!entry) return;
  try { await Promise.all(files.all.map((u) => store(cache, u))); } catch { return; }
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length && seen.size <= WARM_MAX_FILES) {
    const url = queue.shift();
    let res = await cache.match(url);
    if (!res) {
      if (url === entry) return; // the entry is not saved: this is not the build the page runs
      try {
        const got = await fetch(url);
        if (!good(got)) continue;
        await cache.put(url, got.clone());
        res = got;
      } catch { return; } // offline: stop, the next idle moment tries again
    }
    if (!/\.js(\?|$)/.test(url)) continue;
    let text = '';
    try { text = await res.text(); } catch { continue; }
    for (const ref of chunkRefs(text, url)) if (!seen.has(ref)) { seen.add(ref); queue.push(ref); }
  }
}

self.addEventListener('install', () => self.skipWaiting());

// The page talks to the worker for two things (src/main.tsx, watchForUpdates).
self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'refresh-shell') {
    event.waitUntil(refreshShell(new Request(self.registration.scope, { cache: 'no-store' }), true, (p) => event.waitUntil(p))
      .then((res) => { if (!good(res)) throw new Error('not the shell'); })
      .catch(() => { try { event.source && event.source.postMessage({ type: 'shell-refresh-failed' }); } catch { /* the page is gone */ } }));
  } else if (type === 'warm-chunks') {
    event.waitUntil(warmChunks().catch(() => {}));
  }
});

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
  // Cloudflare's own paths sit at the root of the origin, whatever the scope is.
  if (/^\/cdn-cgi(\/|$)/.test(url.pathname)) return;
  const appPath = appPathOf(url);
  if (appPath === null) return;
  if (/^\/(api|ws|cdn-cgi|inbox)(\/|$)/.test(appPath)) return;

  // The launch files: the saved copy at once, refreshed after (W2-H). The first paint never waits on the network.
  if (LAUNCH_FILES.has(appPath) && req.mode !== 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const saved = await cache.match(url.href);
      const fresh = (async () => {
        const res = await fetch(req);
        if (good(res)) await cache.put(url.href, res.clone());
        return res;
      })();
      if (saved) {
        event.waitUntil(fresh.catch(() => {}));
        return saved;
      }
      try { return await fresh; } catch { return Response.error(); }
    })());
    return;
  }

  // Immutable, content-hashed build assets and icons: cache-first.
  if (appPath.startsWith('/assets/') || appPath.startsWith('/icons/')) {
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

  // App-shell navigations: the saved shell at once, refreshed in the background (2026-11-05).
  // Waiting on the network first meant every launch sat on a blank screen until the phone's
  // VPN (Tailscale) woke and the Mac answered, with no time limit. The shell is tiny and only
  // names the content-hashed scripts, so a saved copy is safe to show. The page drops the saved
  // copy itself before a reload that must reach the network (a new version, or the sign-in page;
  // lib/shellCache.ts), and a refresh that comes back as anything but the app drops it here.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const saved = await cache.match(SHELL_URL);
      // The refresh also saves a new build's files and tells the page (refreshShell above).
      const fresh = refreshShell(req, false, (p) => event.waitUntil(p));
      if (saved) {
        event.waitUntil(fresh.catch(() => {}));
        return saved;
      }
      try { return await fresh; } catch { return Response.error(); }
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
      icon: scoped('/icons/icon-192.png'),
      badge: scoped('/icons/icon-192.png'),
      tag: d.terminalId || d.tag || undefined,   // coalesce repeated pings per thread (or per usage window, #127)
      // A plugin's push (`notify:push`) may name an app path to open; never another origin.
      data: { terminalId: d.terminalId || null, sessionId: d.sessionId || null, url: typeof d.url === 'string' && /^\/(?![/\\])/.test(d.url) ? d.url : null },
    });
    // Bump the app-icon count too, so the home screen shows how many alerts are waiting.
    await bumpBadge();
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { terminalId, sessionId, url } = event.notification.data || {};
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
      else if (url && 'navigate' in existing) { try { await existing.navigate(scoped(url)); } catch { /* focused is enough */ } }
      return;
    }
    // Cold path: the mobile shell restores /p/<s>/t/<t> natively; desktop parses it at boot.
    await self.clients.openWindow(scoped(terminalId && sessionId ? `/p/${sessionId}/t/${terminalId}` : (url || '/')));
  })());
});
