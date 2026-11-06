import { lazy, Suspense, type ComponentProps } from 'react';
import { Spinner } from '../common/Spinner';

// The terminal (xterm plus the phone composer) is a large part of the app's code and is only needed
// once a CLI thread is on screen, so it loads then rather than at launch (2026-11-05). After the
// first time the service worker keeps it, so later opens are instant.
const Impl = lazy(() => import('./TerminalTab').then((m) => ({ default: m.TerminalTab })));

/** Start fetching the terminal's code before it is needed (e.g. as soon as the app is idle). */
export function preloadTerminalTab(): void { void import('./TerminalTab'); }

export function TerminalTab(props: ComponentProps<typeof Impl>) {
  return (
    <Suspense fallback={<div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-terminal)' }}><Spinner size={20} /></div>}>
      <Impl {...props} />
    </Suspense>
  );
}
