import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { loadPlugins } from './plugins/host';
import { reloadForSignIn } from './lib/signInReload';
import { reloadFresh } from './lib/shellCache';
// Fonts ship with the app (cached forever) instead of Google Fonts, which blocked the first paint on
// a third-party round trip. Latin only, the three weights the app uses.
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-600.css';
import './theme.css';
import './tailwind.css';
import { usesOsLook } from './lib/hostContext';
import { PRODUCT_NAME } from './lib/hostCopy';

// A hosted workspace names the product from one constant (lib/hostCopy.ts), so a rename is one line.
if (usesOsLook()) document.title = PRODUCT_NAME;

// iOS PWA cold start: env(safe-area-inset-*) can resolve to 0px until the
// viewport is "exercised" (a documented WebKit bug — otherwise it only corrects
// after a physical rotation). Briefly toggle viewport-fit cover→auto→cover to
// force WebKit to recompute the insets, then nudge a few resizes so any
// JS-driven layout (terminal fit) re-measures. Only runs in standalone PWA.
function primeSafeAreaInsets() {
  const standalone = (navigator as unknown as { standalone?: boolean }).standalone
    || window.matchMedia('(display-mode: standalone)').matches;
  // Lets CSS pin height:100vh for the installed PWA (no Safari toolbar, and
  // 100dvh mis-reports on cold start) while the browser uses 100dvh so the
  // bottom input clears Safari's URL/tab bar.
  if (standalone) document.documentElement.classList.add('pwa-standalone');
  if (!standalone) return;
  const meta = document.querySelector('meta[name="viewport"]');
  const original = meta?.getAttribute('content') || '';
  if (meta && original.includes('viewport-fit=cover')) {
    meta.setAttribute('content', original.replace('viewport-fit=cover', 'viewport-fit=auto'));
    requestAnimationFrame(() => {
      meta.setAttribute('content', original);
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    });
  }
  [100, 500, 1000].forEach((d) => setTimeout(() => window.dispatchEvent(new Event('resize')), d));
}
primeSafeAreaInsets();

// Kept out of index.html so the page needs no inline script (Content-Security-Policy: script-src 'self').
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// Auto-update: a standalone PWA can stay open for days, running a stale bundle
// long after a deploy (the window never re-navigates, so it never picks up the
// new content-hashed assets). Poll the HTML shell for the entry script's name and
// reload when it changes — on focus and a slow interval.
//
// W2-H: the reload no longer waits on the network. Before, the page dropped the saved shell and
// reloaded: a blank screen for three round trips plus the script download on a slow link. Now the
// service worker fetches the new shell, saves its script and stylesheet, and then says
// `shell-updated`; the reload that follows comes from the worker's cache. The worker says the same
// when it finds a new build by itself (its refresh after each launch). With no worker, or when the
// worker cannot fetch the build, the page reloads from the network as before.
// At an idle moment the page also asks the worker to save the lazy chunks of this build
// (`warm-chunks`), so the first open of the terminal, the editor or analytics needs no download.
function watchForUpdates() {
  const current = (document.querySelector('script[type="module"][src*="/assets/"]') as HTMLScriptElement | null)?.src;
  if (!current) return;
  const sw = 'serviceWorker' in navigator ? navigator.serviceWorker : undefined;
  let reloading = false;
  /** Set while the worker fetches a new build for us. */
  let waiting: ReturnType<typeof setTimeout> | undefined;
  const stopWaiting = () => { clearTimeout(waiting); waiting = undefined; };
  // The new build is saved: this reload needs no network.
  const reloadSaved = () => { if (reloading) return; reloading = true; stopWaiting(); location.reload(); };
  const reloadNetwork = () => { if (reloading) return; reloading = true; stopWaiting(); void reloadFresh(); };
  /** The entry script a shell names, as an absolute address (the same form as `current`). */
  const entryOf = (html: string): string | null => {
    const m = html.match(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/);
    try { return m ? new URL(m[1], document.baseURI).href : null; } catch { return null; }
  };
  sw?.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { type?: string; entry?: unknown } | null;
    if (d?.type === 'shell-updated' && typeof d.entry === 'string' && d.entry !== current) reloadSaved();
    else if (d?.type === 'shell-refresh-failed' && waiting) reloadNetwork();
  });
  const check = async () => {
    if (reloading || waiting || document.hidden) return;
    try {
      const shell = await fetch(document.baseURI, { cache: 'no-store' });
      if (shell.status === 401) { reloadForSignIn(); return; }
      if (!shell.ok || shell.redirected) return;
      const entry = entryOf(await shell.text());
      if (!entry || entry === current || reloading || waiting) return;
      const worker = sw?.controller;
      if (!worker) { reloadNetwork(); return; }
      // The worker answers `shell-updated` (handled above) or `shell-refresh-failed`. No answer in
      // 20 s (a worker from before W2-H, or a very slow link): the old reload.
      waiting = setTimeout(reloadNetwork, 20_000);
      worker.postMessage({ type: 'refresh-shell' });
    } catch { /* offline / transient — try again next tick */ }
  };
  window.addEventListener('focus', () => void check());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void check(); });
  setInterval(() => void check(), 90_000);

  const warm = () => {
    if ((navigator as unknown as { connection?: { saveData?: boolean } }).connection?.saveData) return; // the user asked the browser to save data
    void sw?.ready.then((reg) => (sw.controller ?? reg.active)?.postMessage({ type: 'warm-chunks' })).catch(() => {});
  };
  if ('requestIdleCallback' in window) window.requestIdleCallback(warm, { timeout: 15_000 }); else setTimeout(warm, 8000);
}
watchForUpdates();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* The last line of defence: a render error outside every view boundary shows a card, not a blank page. */}
    <ErrorBoundary scope="root">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

// Plugins (docs/superpowers/specs/2026-11-07-plugins-design.md): load the enabled plugins' bundles.
void loadPlugins();
// Dictations kept on this device: one left mid-way by a closed app shows as failed in Recordings; old ones go.
void import('./lib/recordings').then(async (r) => { await r.markInterrupted(); await r.pruneRecordings(); }).catch(() => {});
