// W2-H: the service worker (public/sw.js) at launch. The file is a classic worker script, so the test
// runs its text with a fake `self`, a fake cache storage and a fake `fetch`.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SOURCE = fs.readFileSync(path.resolve(import.meta.dirname, '../public/sw.js'), 'utf8');
const ORIGIN = 'https://mac.example';

const keyOf = (k) => new URL(typeof k === 'string' ? k : k.url, ORIGIN + '/').href;
const html = (entry, css = entry) => `<!doctype html><html><head><base href="/" /><script src="theme-boot.js"></script>
<script type="module" crossorigin src="./assets/index-${entry}.js"></script>
<link rel="stylesheet" crossorigin href="./assets/index-${css}.css"></head><body><div id="root"></div></body></html>`;
const ok = (body, type = 'text/plain') => new Response(body, { status: 200, headers: { 'Content-Type': type } });

/** Load sw.js into a fake worker scope. `scope` is the registration scope path. */
function load({ scope = '/' } = {}) {
  const log = [];                       // the order of cache writes and messages
  const stores = new Map();             // cache name -> Map(url -> Response)
  const open = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      match: async (k) => { const hit = m.get(keyOf(k)); return hit ? hit.clone() : undefined; },
      put: async (k, res) => { log.push(`put ${new URL(keyOf(k)).pathname}`); m.set(keyOf(k), res); },
      delete: async (k) => m.delete(keyOf(k)),
    };
  };
  const caches = { open, keys: async () => [...stores.keys()], delete: async (n) => stores.delete(n) };
  const handlers = {};
  const client = { url: ORIGIN + scope, messages: [], postMessage(m) { log.push(`message ${m.type}`); this.messages.push(m); } };
  const self = {
    location: { origin: ORIGIN, href: `${ORIGIN}${scope}sw.js` },
    registration: { scope: ORIGIN + scope, showNotification: vi.fn(async () => {}) },
    navigator: {},
    clients: { matchAll: async () => [client], claim: async () => {}, openWindow: vi.fn(async () => {}) },
    skipWaiting: () => {},
    addEventListener: (type, fn) => { handlers[type] = fn; },
  };
  const fetchMock = vi.fn();
  new Function('self', 'caches', 'fetch', SOURCE)(self, caches, fetchMock);
  /** Dispatch an event; returns what respondWith got and a promise for all waitUntil work. */
  function run(type, props = {}) {
    const waits = [];
    let responded;
    const event = { ...props, waitUntil: (p) => { waits.push(Promise.resolve(p)); }, respondWith: (p) => { responded = Promise.resolve(p); } };
    handlers[type](event);
    return { responded, settled: async () => { for (let i = 0; i < waits.length; i++) await waits[i]; }, handled: responded !== undefined };
  }
  const get = (p, mode = 'no-cors') => run('fetch', { request: { method: 'GET', url: ORIGIN + p, mode } });
  // The versioned cache exists once anything was stored; tests seed it through the worker's own name.
  const seed = async (p, res) => {
    const name = SOURCE.match(/const VERSION = '([^']+)'/)[1];
    await (await open(`dispatch-${name}`)).put(ORIGIN + p, res);
    log.length = 0;
  };
  const stored = async (p) => { const name = SOURCE.match(/const VERSION = '([^']+)'/)[1]; return (await open(`dispatch-${name}`)).match(ORIGIN + p); };
  return { self, client, fetchMock, log, run, get, seed, stored, stores };
}

/** A promise with its resolve function, for a network answer the test holds back. */
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

describe('service worker: the files the first paint waits on (W2-H)', () => {
  it('theme-boot.js comes from the cache with no network wait', async () => {
    const w = load();
    await w.seed('/theme-boot.js', ok('old boot', 'text/javascript'));
    const net = deferred();
    w.fetchMock.mockReturnValue(net.promise); // the network never answers during the launch
    const e = w.get('/theme-boot.js');
    expect(e.handled).toBe(true);
    const res = await e.responded;          // resolves although the network has not answered
    expect(await res.text()).toBe('old boot');
    // The refresh runs after: its answer replaces the saved copy for the next launch.
    net.resolve(ok('new boot', 'text/javascript'));
    await e.settled();
    expect(await (await w.stored('/theme-boot.js')).text()).toBe('new boot');
    expect(w.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('manifest.webmanifest comes from the cache too', async () => {
    const w = load();
    await w.seed('/manifest.webmanifest', ok('{"name":"old"}', 'application/manifest+json'));
    w.fetchMock.mockReturnValue(deferred().promise);
    const res = await w.get('/manifest.webmanifest').responded;
    expect(await res.text()).toBe('{"name":"old"}');
  });

  it('the first request goes to the network and is stored', async () => {
    const w = load();
    w.fetchMock.mockResolvedValue(ok('boot 1', 'text/javascript'));
    const e = w.get('/theme-boot.js');
    expect(await (await e.responded).text()).toBe('boot 1');
    await e.settled();
    expect(await (await w.stored('/theme-boot.js')).text()).toBe('boot 1');
  });

  it('a refresh that is not the file (a sign-in redirect, an error, no network) keeps the saved copy', async () => {
    for (const bad of [
      () => Promise.resolve(Object.defineProperty(ok('<html>sign in</html>', 'text/html'), 'redirected', { value: true })),
      () => Promise.resolve(new Response('nope', { status: 500 })),
      () => Promise.reject(new TypeError('offline')),
    ]) {
      const w = load();
      await w.seed('/theme-boot.js', ok('good boot', 'text/javascript'));
      w.fetchMock.mockImplementation(bad);
      const e = w.get('/theme-boot.js');
      expect(await (await e.responded).text()).toBe('good boot');
      await e.settled();
      expect(await (await w.stored('/theme-boot.js')).text()).toBe('good boot');
    }
  });

  it('with no saved copy and no network the request fails as a network error, not as a hang', async () => {
    const w = load();
    w.fetchMock.mockRejectedValue(new TypeError('offline'));
    const res = await w.get('/theme-boot.js').responded;
    expect(res.type).toBe('error');
  });
});

describe('service worker: paths it leaves alone (W2-H)', () => {
  it('an /api path is not handled', () => {
    const w = load();
    for (const p of ['/api/sessions', '/api/bootstrap', '/api', '/ws', '/ws/x', '/cdn-cgi/access/login', '/inbox/a.png']) {
      expect(w.get(p).handled, p).toBe(false);
      expect(w.get(p, 'navigate').handled, `${p} navigate`).toBe(false);
    }
    // A plugin file is not a build file and not one of the two launch files: the browser asks the daemon.
    expect(w.get('/plugins/p/web.js?v=1').handled).toBe(false);
    expect(w.fetchMock).not.toHaveBeenCalled();
  });

  it('a POST and another origin are not handled', () => {
    const w = load();
    expect(w.run('fetch', { request: { method: 'POST', url: ORIGIN + '/theme-boot.js', mode: 'cors' } }).handled).toBe(false);
    expect(w.run('fetch', { request: { method: 'GET', url: 'https://other.example/theme-boot.js', mode: 'no-cors' } }).handled).toBe(false);
  });

  it('under a base path the tests are relative to the scope', async () => {
    const w = load({ scope: '/u/dw/dispatch/' });
    for (const p of ['/u/dw/dispatch/api/sessions', '/u/dw/dispatch/ws', '/u/dw/dispatch/inbox/x', '/cdn-cgi/access/login', '/api/sessions', '/other/theme-boot.js', '/u/dw/dispatchx/theme-boot.js']) {
      expect(w.get(p).handled, p).toBe(false);
    }
    await w.seed('/u/dw/dispatch/theme-boot.js', ok('scoped boot', 'text/javascript'));
    w.fetchMock.mockReturnValue(deferred().promise);
    expect(await (await w.get('/u/dw/dispatch/theme-boot.js').responded).text()).toBe('scoped boot');
    // Build files under the scope are cache-first, as at the root.
    await w.seed('/u/dw/dispatch/assets/index-A.js', ok('entry A', 'text/javascript'));
    expect(await (await w.get('/u/dw/dispatch/assets/index-A.js').responded).text()).toBe('entry A');
    await w.seed('/u/dw/dispatch/icons/icon-192.png', ok('png', 'image/png'));
    expect(await (await w.get('/u/dw/dispatch/icons/icon-192.png').responded).text()).toBe('png');
  });

  it('a build file is still cache-first at the root, and a miss is fetched and stored', async () => {
    const w = load();
    w.fetchMock.mockResolvedValue(ok('chunk', 'text/javascript'));
    const e = w.get('/assets/Lazy-1.js');
    expect(await (await e.responded).text()).toBe('chunk');
    await e.settled();
    const again = w.get('/assets/Lazy-1.js');
    expect(await (await again.responded).text()).toBe('chunk');
    expect(w.fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('service worker: a new build (W2-H)', () => {
  const answers = (w, map) => w.fetchMock.mockImplementation((req) => {
    const p = new URL(keyOf(req)).pathname;
    const hit = map[p];
    if (hit === undefined) return Promise.resolve(new Response('missing', { status: 404 }));
    return typeof hit === 'function' ? hit() : Promise.resolve(hit.clone());
  });

  it('a new shell stores the new entry chunk before the message', async () => {
    const w = load();
    await w.seed('/', ok(html('A'), 'text/html'));
    await w.seed('/assets/index-A.js', ok('entry A', 'text/javascript'));
    answers(w, { '/': ok(html('B'), 'text/html'), '/assets/index-B.js': ok('entry B', 'text/javascript'), '/assets/index-B.css': ok('css B', 'text/css') });
    const e = w.get('/', 'navigate');
    // The launch itself shows the saved shell at once.
    expect(await (await e.responded).text()).toBe(html('A'));
    await e.settled();
    expect(w.client.messages).toEqual([{ type: 'shell-updated', entry: `${ORIGIN}/assets/index-B.js` }]);
    const iMsg = w.log.indexOf('message shell-updated');
    expect(w.log.indexOf('put /assets/index-B.js')).toBeGreaterThanOrEqual(0);
    expect(w.log.indexOf('put /assets/index-B.js')).toBeLessThan(iMsg);
    expect(w.log.indexOf('put /assets/index-B.css')).toBeLessThan(iMsg);
    expect(w.log.indexOf('put /')).toBeLessThan(iMsg);
    // The next launch needs no network: the new shell, its script and its stylesheet are all saved.
    expect(await (await w.stored('/')).text()).toBe(html('B'));
    expect(await (await w.stored('/assets/index-B.js')).text()).toBe('entry B');
    expect(await (await w.stored('/assets/index-B.css')).text()).toBe('css B');
  });

  it('the same shell sends no message and fetches no build file again', async () => {
    const w = load();
    await w.seed('/', ok(html('A'), 'text/html'));
    await w.seed('/assets/index-A.js', ok('entry A', 'text/javascript'));
    await w.seed('/assets/index-A.css', ok('css A', 'text/css'));
    answers(w, { '/': ok(html('A'), 'text/html') });
    const e = w.get('/', 'navigate');
    await e.responded;
    await e.settled();
    expect(w.client.messages).toEqual([]);
    expect(w.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a new shell whose entry cannot be fetched keeps the old saved shell and sends no message', async () => {
    const w = load();
    await w.seed('/', ok(html('A'), 'text/html'));
    answers(w, { '/': ok(html('B'), 'text/html'), '/assets/index-B.js': () => Promise.reject(new TypeError('offline')) });
    const e = w.get('/', 'navigate');
    await e.responded;
    await e.settled();
    expect(w.client.messages).toEqual([]);
    expect(await (await w.stored('/')).text()).toBe(html('A'));
  });

  it('a refresh that is the sign-in page drops the saved shell, as before', async () => {
    const w = load();
    await w.seed('/', ok(html('A'), 'text/html'));
    w.fetchMock.mockResolvedValue(Object.defineProperty(ok('<html>sign in</html>', 'text/html'), 'redirected', { value: true }));
    const e = w.get('/', 'navigate');
    await e.responded;
    await e.settled();
    expect(await w.stored('/')).toBeUndefined();
    expect(w.client.messages).toEqual([]);
  });

  it('the first launch (no saved shell) answers from the network, stores the shell and its files, and sends no message', async () => {
    const w = load();
    answers(w, { '/': ok(html('A'), 'text/html'), '/assets/index-A.js': ok('entry A', 'text/javascript'), '/assets/index-A.css': ok('css A', 'text/css') });
    // The entry download is slow: the page must get the shell without it.
    const slow = deferred();
    answers(w, { '/': ok(html('A'), 'text/html'), '/assets/index-A.js': () => slow.promise, '/assets/index-A.css': ok('css A', 'text/css') });
    const e = w.get('/', 'navigate');
    expect(await (await e.responded).text()).toBe(html('A'));
    expect(await (await w.stored('/')).text()).toBe(html('A'));
    slow.resolve(ok('entry A', 'text/javascript'));
    await e.settled();
    expect(await (await w.stored('/assets/index-A.js')).text()).toBe('entry A');
    expect(w.client.messages).toEqual([]);
  });

  it('the page can ask for the refresh: the answer names the entry after its files are stored', async () => {
    const w = load();
    await w.seed('/', ok(html('B'), 'text/html')); // the saved shell is already the new one
    answers(w, { '/': ok(html('B'), 'text/html'), '/assets/index-B.js': ok('entry B', 'text/javascript'), '/assets/index-B.css': ok('css B', 'text/css') });
    const e = w.run('message', { data: { type: 'refresh-shell' }, source: w.client });
    await e.settled();
    expect(w.client.messages).toEqual([{ type: 'shell-updated', entry: `${ORIGIN}/assets/index-B.js` }]);
    expect(w.log.indexOf('put /assets/index-B.js')).toBeLessThan(w.log.indexOf('message shell-updated'));
  });

  it('a refresh the page asked for that fails says so', async () => {
    const w = load();
    w.fetchMock.mockRejectedValue(new TypeError('offline'));
    const e = w.run('message', { data: { type: 'refresh-shell' }, source: w.client });
    await e.settled();
    expect(w.client.messages).toEqual([{ type: 'shell-refresh-failed' }]);
  });

  it('warm-chunks stores the lazy chunks that the entry names, once', async () => {
    const w = load();
    const entry = 'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./TerminalTab-a1.js","./TerminalTab-b2.css","./NotesTab-c3.js"])))=>i.map(i=>d[i]);const A=()=>import("./AnalyticsView-d4.js");import"./vendor-e5.js";';
    await w.seed('/', ok(html('A'), 'text/html'));
    await w.seed('/assets/index-A.js', ok(entry, 'text/javascript'));
    await w.seed('/assets/index-A.css', ok('css A', 'text/css'));
    await w.seed('/assets/NotesTab-c3.js', ok('notes', 'text/javascript'));
    answers(w, {
      '/assets/TerminalTab-a1.js': ok('import"./xterm-f6.js";', 'text/javascript'),
      '/assets/TerminalTab-b2.css': ok('css', 'text/css'),
      '/assets/AnalyticsView-d4.js': ok('analytics', 'text/javascript'),
      '/assets/vendor-e5.js': ok('vendor', 'text/javascript'),
      '/assets/xterm-f6.js': ok('xterm', 'text/javascript'),
    });
    await w.run('message', { data: { type: 'warm-chunks' }, source: w.client }).settled();
    for (const p of ['/assets/TerminalTab-a1.js', '/assets/TerminalTab-b2.css', '/assets/AnalyticsView-d4.js', '/assets/vendor-e5.js', '/assets/xterm-f6.js']) {
      expect(await w.stored(p), p).toBeDefined();
    }
    const asked = w.fetchMock.mock.calls.map((c) => new URL(keyOf(c[0])).pathname).sort();
    expect(asked).toEqual(['/assets/AnalyticsView-d4.js', '/assets/TerminalTab-a1.js', '/assets/TerminalTab-b2.css', '/assets/vendor-e5.js', '/assets/xterm-f6.js']);
    // A second call finds everything saved.
    w.fetchMock.mockClear();
    await w.run('message', { data: { type: 'warm-chunks' }, source: w.client }).settled();
    expect(w.fetchMock).not.toHaveBeenCalled();
  });

  it('warm-chunks on the first visit (nothing saved) saves the shell, its files and the lazy chunks', async () => {
    const w = load();
    answers(w, {
      '/': ok(html('A'), 'text/html'),
      '/assets/index-A.js': ok('const A=()=>import("./Lazy-z9.js");', 'text/javascript'),
      '/assets/index-A.css': ok('css A', 'text/css'),
      '/assets/Lazy-z9.js': ok('lazy', 'text/javascript'),
    });
    await w.run('message', { data: { type: 'warm-chunks' }, source: w.client }).settled();
    expect(await (await w.stored('/')).text()).toBe(html('A'));
    for (const p of ['/assets/index-A.js', '/assets/index-A.css', '/assets/Lazy-z9.js']) expect(await w.stored(p), p).toBeDefined();
    expect(w.client.messages).toEqual([]);
  });

  it('warm-chunks with no network and nothing saved does nothing', async () => {
    const w = load();
    w.fetchMock.mockRejectedValue(new TypeError('offline'));
    await w.run('message', { data: { type: 'warm-chunks' }, source: w.client }).settled();
    expect(await w.stored('/')).toBeUndefined();
  });

  it('an unknown message does nothing', async () => {
    const w = load();
    await w.run('message', { data: { type: 'nope' }, source: w.client }).settled();
    await w.run('message', { data: null, source: w.client }).settled();
    expect(w.fetchMock).not.toHaveBeenCalled();
  });
});

describe('service worker: version and alerts (W2-H)', () => {
  it('the cache version moved on from v7, and activate drops the old cache but keeps the intent and badge caches', async () => {
    expect(SOURCE).toMatch(/const VERSION = 'dispatch-v(?!7')\d+'/);
    const w = load();
    for (const n of ['dispatch-dispatch-v7', 'dispatch-intent', 'dispatch-badge']) w.stores.set(n, new Map());
    await w.run('activate').settled();
    expect([...w.stores.keys()].sort()).toEqual(['dispatch-badge', 'dispatch-intent']);
  });

  it('under a base path an alert uses the icon and the thread address of the scope', async () => {
    const w = load({ scope: '/u/dw/dispatch/' });
    await w.run('push', { data: { json: () => ({ title: 'Done', body: 'b', terminalId: 't1', sessionId: 's1' }) } }).settled();
    expect(w.self.registration.showNotification.mock.calls[0][1].icon).toBe('/u/dw/dispatch/icons/icon-192.png');
    w.self.clients.matchAll = async () => [];
    await w.run('notificationclick', { notification: { close() {}, data: { terminalId: 't1', sessionId: 's1' } } }).settled();
    expect(w.self.clients.openWindow).toHaveBeenCalledWith('/u/dw/dispatch/p/s1/t/t1');
  });

  it('at the root an alert keeps the addresses it had', async () => {
    const w = load();
    await w.run('push', { data: { json: () => ({ title: 'Done', terminalId: 't1', sessionId: 's1' }) } }).settled();
    expect(w.self.registration.showNotification.mock.calls[0][1].icon).toBe('/icons/icon-192.png');
    w.self.clients.matchAll = async () => [];
    await w.run('notificationclick', { notification: { close() {}, data: { terminalId: 't1', sessionId: 's1' } } }).settled();
    expect(w.self.clients.openWindow).toHaveBeenCalledWith('/p/s1/t/t1');
  });
});
