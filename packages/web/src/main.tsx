import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './theme.css';

// iOS PWA cold start: env(safe-area-inset-*) can resolve to 0px until the
// viewport is "exercised" (a documented WebKit bug — otherwise it only corrects
// after a physical rotation). Briefly toggle viewport-fit cover→auto→cover to
// force WebKit to recompute the insets, then nudge a few resizes so any
// JS-driven layout (terminal fit) re-measures. Only runs in standalone PWA.
function primeSafeAreaInsets() {
  const standalone = (navigator as unknown as { standalone?: boolean }).standalone
    || window.matchMedia('(display-mode: standalone)').matches;
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

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
