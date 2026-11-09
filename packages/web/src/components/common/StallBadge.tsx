import { useEffect, useState } from 'react';
import { HourglassMedium } from '@phosphor-icons/react';
import { ensureStallsLoaded, useThreadStatus } from '../../stores/threadStatus';

/** The badge text. The daemon flags after 10 minutes of silence, so the count is never under 1. */
export function stallTitle(stalledSince: number, now: number): string {
  const minutes = Math.max(1, Math.floor((now - stalledSince) / 60_000));
  return `No output for ${minutes} min. The thread can still be at work.`;
}

/**
 * A small hourglass on a thread that the daemon's stall watchdog flagged: its status is "working"
 * and it sent no output for longer than the threshold. Information only, in a neutral colour: a
 * long tool call or a slow model is not an error. Renders nothing for a thread with no flag.
 */
export function StallBadge({ terminalId, size = 13 }: { terminalId: string; size?: number }) {
  const stalledSince = useThreadStatus((s) => s.stalls[terminalId]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { ensureStallsLoaded(); }, []);
  // The minute count moves only while the badge shows.
  useEffect(() => {
    if (stalledSince === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [stalledSince]);
  if (stalledSince === undefined) return null;
  const title = stallTitle(stalledSince, now);
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      data-testid="stall-badge"
      style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0, color: 'var(--color-text-tertiary)', lineHeight: 0 }}
    >
      <HourglassMedium size={size} weight="regular" aria-hidden />
    </span>
  );
}
