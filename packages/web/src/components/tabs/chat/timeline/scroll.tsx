import { useEffect, useLayoutEffect, useRef } from 'react';
import { MessageScroller, useMessageScroller, useMessageScrollerScrollable } from '@shadcn/react/message-scroller';
import { CaretDoubleDown } from '@phosphor-icons/react';
import { useBootstrapOlderPages } from '../../../../hooks/useBootstrapOlderPages';
import { Spinner } from '../../../common/Spinner';
import { fontVar } from '../../../../lib/fontSize';

/**
 * Render-nothing helper: keep a freshly-opened (or freshly-switched) thread pinned to
 * the bottom through its post-mount backfill burst. shadcn's autoScroll follows LIVE
 * deltas while the user is pinned, but the initial replay arrives as a rapid append
 * burst that can strand the viewport above the fold (a content change can flip the
 * scroller out of "following-bottom" before it catches up). We force scrollToEnd('auto')
 * — instant, never smooth — on each append while still engaged, then hand off to native
 * autoScroll the moment the user scrolls off-tail. Crucially this runs in a LAYOUT effect
 * (pre-paint): the stick lands before the browser paints each backfill frame, so the thread
 * opens ALREADY at the bottom instead of visibly scrolling top→bottom through its history.
 */
export function StickToEndOnLoad({ terminalId, count, onReady }: { terminalId: string | null; count: number; onReady?: () => void }) {
  const { scrollToEnd } = useMessageScroller();
  const { end } = useMessageScrollerScrollable(); // end === true ⇒ off-tail (content below the fold)
  const settledRef = useRef(false);
  const prevCountRef = useRef(-1);
  const termRef = useRef(terminalId);
  const readyRef = useRef(false); // latched — onReady fires at most once per catch-up
  const quietTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    // New thread → re-arm so its own backfill re-sticks to the bottom, and hide again
    // until it settles (the parent's paint gate — see the `ready` state at the render).
    if (termRef.current !== terminalId) {
      termRef.current = terminalId;
      settledRef.current = false;
      prevCountRef.current = -1;
      readyRef.current = false;
      if (quietTimerRef.current != null) { clearTimeout(quietTimerRef.current); quietTimerRef.current = null; }
    }
    // Reveal latch (back-ported from the Control Plane Stream): any real count change
    // restarts a short quiet-window timer; once ~180ms passes with no further growth the
    // burst has caught up and onReady fires ONCE. A count regression below re-arms it, so
    // a ws-reconnect replay hides through ITS catch-up too.
    if (count < prevCountRef.current) readyRef.current = false;
    if (!readyRef.current && count !== prevCountRef.current) {
      if (quietTimerRef.current != null) clearTimeout(quietTimerRef.current);
      quietTimerRef.current = setTimeout(() => {
        quietTimerRef.current = null;
        if (!readyRef.current) { readyRef.current = true; onReady?.(); }
      }, 180);
    }
    // `items` only ever GROWS or RESETS-TO-EMPTY (useStructuredChat appends or setItems([])),
    // so a count regression unambiguously means the list was cleared/replaced — a ws-reconnect
    // `onReset` replay (same terminalId) or a non-keyed remount whose outgoing-thread count
    // (e.g. 50) still sits in prevCountRef while the new backfill climbs 0→N<50. Re-arm so the
    // append burst exceeds prevCount and re-sticks. (Handles tab-switch + reconnect + replay.)
    if (count < prevCountRef.current) prevCountRef.current = -1;
    if (settledRef.current) return;
    if (count > prevCountRef.current) {
      // Backfill / live append while still engaged → snap to the bottom. We scroll even
      // when `end` reads off-tail: during the burst the viewport legitimately starts above
      // the fold and must be pulled down. (Right after our own scroll `end` reads stale-true
      // for a frame — but that frame is a count-GROWTH tick, handled here, never below.)
      prevCountRef.current = count;
      scrollToEnd({ behavior: 'auto' });
      return;
    }
    // Count held steady AND we're parked off-tail → the user scrolled up themselves.
    // Disengage for the rest of this thread; native autoScroll owns follow-while-pinned now.
    if (end) settledRef.current = true;
  }, [terminalId, count, end, scrollToEnd, onReady]);

  useEffect(() => () => {
    if (quietTimerRef.current != null) clearTimeout(quietTimerRef.current);
  }, []);

  return null;
}

/**
 * Render-nothing helper: pages in older history right after mount/thread-switch/reconnect
 * when the initial content is too short to overflow the viewport — otherwise the reader has
 * nothing to scroll and onViewportScroll's near-top trigger never fires, stranding `hasMore:
 * true` history that's unreachable through the UI. See useBootstrapOlderPages's doc comment.
 */
export function BootstrapOlderPages(props: { hasMore: boolean; loadingOlder: boolean; loadOlder: () => void }) {
  useBootstrapOlderPages(props);
  return null;
}

/**
 * Explicit "Load earlier messages" control, rendered as the FIRST child of
 * MessageScroller.Content (above the timeline). Paging older history otherwise depends
 * entirely on the reader being able to SCROLL — onViewportScroll's near-top trigger, or
 * useBootstrapOlderPages' overflow check — which strands history whenever the current
 * window is short enough not to overflow (in the limit: nothing rendered at all, so there
 * is nothing to scroll). A tappable control makes older history reachable unconditionally,
 * on desktop and mobile alike. Hidden while a fetch is in flight — the floating
 * <LoadingOlderPill/> owns that state.
 */
export function LoadEarlierButton({ show, onClick }: { show: boolean; onClick: () => void }) {
  if (!show) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        alignSelf: 'center',
        font: `500 ${fontVar(12)} var(--font-sans)`,
        color: 'var(--color-text-secondary)',
        background: 'var(--color-elevated)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        padding: '5px 12px',
        cursor: 'pointer',
      }}
    >
      Load earlier messages
    </button>
  );
}

/**
 * Floating "Loading earlier…" pill shown while loadOlder() is in flight. Deliberately
 * rendered as a sibling of MessageScroller.Viewport (absolutely positioned over it), NOT
 * as a Content child: the vendored scroller's preserveScrollOnPrepend keeps the reader's
 * position by diffing Content's actual children across a mutation, and toggling a node
 * in and out of that list right alongside the real prepend (both land in the same React
 * commit) can race that diff. Floating it outside Content sidesteps that entirely.
 */
export function LoadingOlderPill({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 'var(--radius-2xl)', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', color: 'var(--color-text-tertiary)', fontSize: fontVar(11.5), zIndex: 5, pointerEvents: 'none' }}>
      <Spinner size={11} /> Loading earlier…
    </div>
  );
}

/** shadcn MessageScroller.Button — floating "jump to latest", shown only off-tail. */
export function JumpButton() {
  const { end } = useMessageScrollerScrollable();
  if (!end) return null;
  return (
    <MessageScroller.Button
      direction="end"
      style={{ position: 'absolute', right: 16, bottom: 16, width: 40, height: 40, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-accent)', color: 'var(--color-on-accent)', border: 'none', boxShadow: '0 8px 22px -6px var(--color-shadow)', cursor: 'pointer', zIndex: 5 }}
    >
      <CaretDoubleDown size={18} weight="bold" />
    </MessageScroller.Button>
  );
}
