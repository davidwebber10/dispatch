import { useEffect, useState } from 'react';

/** A clock that ticks, so a time-based label (a reset passing, a figure going stale) updates without a new event. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), everyMs); return () => clearInterval(t); }, [everyMs]);
  return now;
}
