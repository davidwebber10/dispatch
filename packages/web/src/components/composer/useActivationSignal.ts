import { useEffect, useRef, useState } from 'react';
import { useTabs } from '../../stores/tabs';
import { useIsMobile } from '../../hooks/useIsMobile';

/**
 * A number that goes up each time this thread becomes the open tab, on the desktop only (owner,
 * 2026-11-16: a tab click highlights its composer, "just on desktop, not mobile": a focus on a phone
 * opens the keyboard). 0 until the first time. Pass it to PillComposer's `focusSignal`.
 */
export function useActivationSignal(terminalId: string | null | undefined): number {
  const isMobile = useIsMobile();
  const active = useTabs((s) => !!terminalId && s.activeTabId === terminalId);
  const [n, setN] = useState(0);
  const was = useRef(false);
  useEffect(() => {
    if (active && !was.current && !isMobile) setN((x) => x + 1);
    was.current = active;
  }, [active, isMobile]);
  return n;
}
