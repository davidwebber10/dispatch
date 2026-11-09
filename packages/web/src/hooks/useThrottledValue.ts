import { useEffect, useRef, useState } from 'react';

/**
 * A value that changes many times a second, passed on at most once per `ms` (engineering program
 * 2026-11-09, W2-E). It is a throttle, not a debounce: during a run of changes the result moves
 * every `ms`, and the last value always arrives, at the latest `ms` after the last change.
 *
 * `active` false passes every value through in the same render, with no timer. So the caller gets
 * the final value at once when the run ends (a streamed message that finished).
 */
export function useThrottledValue<T>(value: T, ms: number, active: boolean): T {
  const shown = useRef(value);
  const latest = useRef(value);
  const lastAt = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, render] = useState(0);

  if (lastAt.current === null) lastAt.current = Date.now(); // the first value counts as passed on at mount
  latest.current = value;
  // Not active: the result follows the value, so a later turn to active starts from the current one.
  if (!active) shown.current = value;

  useEffect(() => {
    if (!active) {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      return;
    }
    if (Object.is(shown.current, value) || timer.current) return; // a booked slot reads the latest value
    const pass = () => {
      timer.current = null;
      lastAt.current = Date.now();
      shown.current = latest.current;
      render((n) => n + 1);
    };
    const wait = (lastAt.current ?? 0) + ms - Date.now();
    if (wait <= 0) pass();
    else timer.current = setTimeout(pass, wait);
  }, [value, ms, active]);

  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } }, []);

  return active ? shown.current : value;
}

/**
 * True from the render that sees `value` change until `quietMs` pass with no change. The chat's
 * assistant-text leaf uses it to know that its text is still arriving: no surface has to tell it,
 * and it always ends (a flag from the transport could stay set when the last event is lost).
 * A value that is the same from mount on is never "recently changed" (a message from history).
 */
export function useRecentlyChanged<T>(value: T, quietMs: number): boolean {
  const prev = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hot, setHot] = useState(false);
  const changed = !Object.is(prev.current, value);

  useEffect(() => {
    if (Object.is(prev.current, value)) return;
    prev.current = value;
    setHot(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; setHot(false); }, quietMs);
  }, [value, quietMs]);

  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } }, []);

  return hot || changed;
}
