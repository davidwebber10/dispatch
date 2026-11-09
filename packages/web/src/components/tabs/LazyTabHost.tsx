import { lazy, Suspense, type ComponentProps } from 'react';
import { Spinner } from '../common/Spinner';

// The thread view (the chat, its tool views, the composer) is not in the shells' own code
// (engineering program 2026-11-09, W2-E). The phone's first screen is the list of threads, so the
// phone paints without it and fetches it when the app is idle (preloadTabHost); the desktop shows a
// thread at once, so index.html preloads it there together with the shell (vite.config.ts).
const load = () => import('./TabHost');
const Impl = lazy(() => load().then((m) => ({ default: m.TabHost })));

/** Start the fetch of the thread view's code before a thread is opened. */
export function preloadTabHost(): void { void load().catch(() => {}); }

const fallback = <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner size={20} /></div>;

export function TabHost(props: ComponentProps<typeof Impl>) {
  return <Suspense fallback={fallback}><Impl {...props} /></Suspense>;
}
