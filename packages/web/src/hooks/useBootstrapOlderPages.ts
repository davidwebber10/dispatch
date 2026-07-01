import { useEffect, useRef } from 'react';
import { useMessageScrollerScrollable } from '@shadcn/react/message-scroller';

// Hard cap on consecutive bootstrap fetches. A real thread's `hasMore` clears or the
// viewport overflows well before this — it only guards a pathological transcript (e.g. a
// long run of skipped/bookkeeping-only lines, or an all-duplicate page from the loadOlder
// dedup safety net) from hammering the REST endpoint forever.
const MAX_ATTEMPTS = 40;

/**
 * loadOlder() only ever fires from a scroll-near-top event (see ChatView/Stream's own
 * onViewportScroll). If the initial page — the ws replay's tail, bounded to the last 200
 * ring events (structured-socket.ts) — is short enough to fit the viewport with no
 * overflow, the reader can never scroll and `hasMore: true` history stays stuck, unreachable,
 * forever (confirmed live: a long coordinator thread replays as few as ~8 rendered turns).
 *
 * Call this from a render-nothing child mounted INSIDE <MessageScroller.Root> (it needs the
 * scroller's context, same as StickToEndOnLoad/JumpButton in ChatView.tsx and Stream.tsx) to
 * keep paging in older content right after mount/thread-switch/reconnect until EITHER the
 * viewport genuinely overflows (the reader can now scroll for more themselves) or hasMore
 * goes false. Each loadOlder() page is deduped against what's already rendered (see
 * useStructuredChat's convItemFingerprint), so an all-duplicate page just advances the
 * anchor with no visible flicker instead of stalling the loop.
 */
export function useBootstrapOlderPages({
  hasMore,
  loadingOlder,
  loadOlder,
}: {
  hasMore: boolean;
  loadingOlder: boolean;
  loadOlder: () => void;
}) {
  const { start, end } = useMessageScrollerScrollable();
  const overflowing = start || end;
  const attemptsRef = useRef(0);
  const loadOlderRef = useRef(loadOlder);

  useEffect(() => {
    // `loadOlder`'s identity changes per terminalId (useStructuredChat's useCallback deps
    // on it) — a change here means a thread switch, so the attempt count from the OUTGOING
    // thread must not carry over and cap the incoming one.
    if (loadOlderRef.current !== loadOlder) {
      loadOlderRef.current = loadOlder;
      attemptsRef.current = 0;
    }
    if (overflowing) { attemptsRef.current = 0; return; }
    if (!hasMore || loadingOlder || attemptsRef.current >= MAX_ATTEMPTS) return;
    attemptsRef.current += 1;
    loadOlder();
  }, [overflowing, hasMore, loadingOlder, loadOlder]);
}
