// The footer under a thread's terminal (2026-10-12): the "This thread is asking you" strip and, on a
// CLI AI thread, the latest declared outcome — at the bottom, where a Pretty thread shows them.
//
// Every change in the footer's height resizes the terminal, and Codex's inline TUI answers every
// resize by clearing its scrollback and printing about 1000 lines of history again. The strip and
// the card used to change on every submit. So while a turn runs, the footer keeps the height it had
// when the turn began; when the turn settles, it takes its natural height again (at most one resize
// per turn, at its end, and none when the height is the same).

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useThreadStatus } from '../../stores/threadStatus';

export function TurnFooter({ terminalId, children }: { terminalId: string; children?: ReactNode }) {
  const threadStatus = useThreadStatus((s) => s.byTerminal[terminalId]?.threadStatus);
  const working = threadStatus === 'working' || threadStatus === 'starting';
  const ref = useRef<HTMLDivElement>(null);
  // The footer's height at the last render while the thread was settled. Read during render on
  // purpose: the render in which `working` turns true must already carry that height in the same
  // commit, or the terminal sees one frame of the smaller footer and resizes. The exact height, not
  // offsetHeight: a rounded hold still moves the terminal by a pixel, and xterm can measure its
  // rows again on that resize.
  const settledHeight = useRef(0);
  const workingRef = useRef(working);
  workingRef.current = working;
  useLayoutEffect(() => {
    if (!working && ref.current) settledHeight.current = ref.current.getBoundingClientRect().height;
  });
  // A child can change its height without rendering the footer (the card refetches its outcome
  // after a turn settles), so a ResizeObserver keeps the settled height current between renders.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (!workingRef.current) settledHeight.current = el.getBoundingClientRect().height;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const hold = working && settledHeight.current > 0 ? settledHeight.current : undefined;
  return (
    <div ref={ref} data-testid="turn-footer" style={{ flexShrink: 0, minHeight: hold }}>
      {children}
    </div>
  );
}
