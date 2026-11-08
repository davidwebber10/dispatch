// The footer under a thread's terminal (2026-10-12): on a CLI AI thread, the latest declared outcome (the ask strip is
// gone, 2026-11-07) — at the bottom, where a Pretty thread shows them.
//
// Every change in the footer's height resizes the terminal, and Codex's inline TUI answers every
// resize by clearing its scrollback and printing about 1000 lines of history again. The strip and
// the card used to change on every submit. So while a turn runs the footer keeps, exactly, the
// height it had when the turn began. It keeps it for SETTLE_HOLD_MS after the turn settles too: the
// strip comes from the live status at once, but the card fetches the new outcome a moment later,
// and letting go before both are in would resize twice (review round 1). One resize per turn at
// most, and none when the height is the same.
//
// The one exception is the user closing something in the footer (the card's ×) mid-turn: that
// shrink is asked for, so the hold lets go at once. Holding it left an empty band under the
// terminal until the turn ended (2026-11-05).

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useThreadStatus } from '../../stores/threadStatus';
import { useDismissedNotices } from '../../stores/dismissedNotices';

export const SETTLE_HOLD_MS = 1500;

export function TurnFooter({ terminalId, children }: { terminalId: string; children?: ReactNode }) {
  const threadStatus = useThreadStatus((s) => s.byTerminal[terminalId]?.threadStatus);
  const working = threadStatus === 'working' || threadStatus === 'starting';

  // The turn edges, as state from the previous render (React's "adjust state while rendering"
  // pattern): the render in which a turn ends must already hold, or one commit without the hold
  // would be measured and laid out.
  const [prevWorking, setPrevWorking] = useState(working);
  const [settling, setSettling] = useState(false);
  if (working !== prevWorking) {
    setPrevWorking(working);
    setSettling(!working);
  }
  useEffect(() => {
    if (!settling) return;
    const t = setTimeout(() => setSettling(false), SETTLE_HOLD_MS);
    return () => clearTimeout(t);
  }, [settling]);
  const holding = working || settling;

  // The footer's exact height (getBoundingClientRect: a rounded hold still moves the terminal by a
  // pixel, and xterm can measure its rows again on that resize) at the last moment it was not held,
  // for THIS thread: the same terminal view can switch threads without a remount (review round 1).
  const ref = useRef<HTMLDivElement>(null);
  const settled = useRef<{ id: string; height: number } | null>(null);
  const live = useRef({ holding, terminalId });
  live.current = { holding, terminalId };
  useLayoutEffect(() => {
    if (!holding && ref.current) settled.current = { id: terminalId, height: ref.current.getBoundingClientRect().height };
  });
  // A child can change its height without rendering the footer (the card refetches its outcome),
  // so a ResizeObserver keeps the measurement current between renders.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (!live.current.holding) settled.current = { id: live.current.terminalId, height: el.getBoundingClientRect().height };
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // This thread's dismissals, as one string so a new one always reads as a change (the store caps
  // its list, so a count could stay the same while a key comes and another goes).
  const dismissedHere = useDismissedNotices((st) => st.keys.filter((k) => k.startsWith(`${terminalId}:`)).join('|'));
  const [prevDismissed, setPrevDismissed] = useState(dismissedHere);
  if (dismissedHere !== prevDismissed) {
    setPrevDismissed(dismissedHere);
    settled.current = null; // released for the rest of this turn
  }

  const s = settled.current;
  const hold = holding && s && s.id === terminalId && s.height > 0 ? s.height : undefined;
  return (
    <div ref={ref} data-testid="turn-footer" style={{ flexShrink: 0, height: hold, overflow: hold !== undefined ? 'hidden' : undefined }}>
      {children}
    </div>
  );
}
