import { lazy, Suspense, type ComponentProps } from 'react';
import { Spinner } from '../common/Spinner';

// The Chat view is not in the shells' own code (engineering program 2026-11-09, W2-E): it loads
// when the Chat view is first on screen.
const load = () => import('./ChatMode');
const Impl = lazy(() => load().then((m) => ({ default: m.ChatMode })));

/** Start the fetch of the Chat view's code before it is opened. */
export function preloadChatMode(): void { void load().catch(() => {}); }

const fallback = <div style={{ flex: 1, minWidth: 0, minHeight: 0, height: '100%', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner size={22} /></div>;

export function ChatMode(props: ComponentProps<typeof Impl>) {
  return <Suspense fallback={fallback}><Impl {...props} /></Suspense>;
}
