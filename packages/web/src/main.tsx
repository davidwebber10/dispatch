import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
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
// new content-hashed assets). Poll the HTML shell for the entry script's hash and
// reload when it changes — on focus and a slow interval. reload() re-navigates,
// which the service worker serves network-first, pulling the fresh shell + assets.
function watchForUpdates() {
  const current = (document.querySelector('script[type="module"][src*="/assets/index-"]') as HTMLScriptElement | null)?.src;
  if (!current) return;
  let reloading = false;
  const check = async () => {
    if (reloading || document.hidden) return;
    try {
      const shell = await fetch('/', { cache: 'no-store' });
      if (shell.status === 401) { reloadForSignIn(); return; }
      const html = await shell.text();
      const m = html.match(/\/assets\/index-[A-Za-z0-9_]+\.js/);
      if (m && !current.endsWith(m[0])) { reloading = true; void reloadFresh(); }
    } catch { /* offline / transient — try again next tick */ }
  };
  window.addEventListener('focus', () => void check());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void check(); });
  setInterval(() => void check(), 90_000);
}
watchForUpdates();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Plugins (docs/superpowers/specs/2026-11-07-plugins-design.md): load the enabled plugins' bundles.
void loadPlugins();
// Dictations kept on this device: one left mid-way by a closed app shows as failed in Recordings; old ones go.
void import('./lib/recordings').then(async (r) => { await r.markInterrupted(); await r.pruneRecordings(); }).catch(() => {});
