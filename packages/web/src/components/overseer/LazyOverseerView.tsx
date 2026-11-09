import { lazy, Suspense, type ComponentProps } from 'react';
import { Spinner } from '../common/Spinner';

// The Control Plane view is not in the first load (engineering program 2026-11-09, W2-E): it loads
// when the Control Plane is first on screen. Both shells draw it through this wrapper.
const Impl = lazy(() => import('./OverseerView').then((m) => ({ default: m.OverseerView })));

/** Start the fetch of the Control Plane's code before it is needed (e.g. when the app is idle). */
export function preloadOverseerView(): void { void import('./OverseerView').catch(() => {}); }

const fallback = (
  <div style={{ flex: 1, minHeight: 0, height: '100%', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    <Spinner size={22} />
  </div>
);

export function OverseerView(props: ComponentProps<typeof Impl>) {
  return <Suspense fallback={fallback}><Impl {...props} /></Suspense>;
}
