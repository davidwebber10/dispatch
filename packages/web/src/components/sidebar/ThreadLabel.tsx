import { useEffect, useState } from 'react';
import type { Terminal } from '../../api/types';
import { useTabs } from '../../stores/tabs';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';

const DELETE_MS = 25;
const TYPE_MS = 35;

/**
 * The thread-row label. Normally renders `tab.label` verbatim; when the tabs store
 * has just observed this thread auto-name itself, it backspaces the old label away
 * and types the new one in. The store is always the truth — this is presentation
 * only, so an unmount mid-animation simply leaves the final label behind.
 */
export function ThreadLabel({ tab }: { tab: Terminal }) {
  // null means "not animating — show tab.label"
  const [typed, setTyped] = useState<string | null>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    // getState() rather than a selector: consuming must not re-subscribe this component.
    const entry = useTabs.getState().consumeAutoName(tab.id);
    if (!entry || reduced) {
      setTyped(null); // also cancels any in-flight animation when tab.label changes under us
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const del = (n: number) => {
      if (cancelled) return;
      setTyped(entry.from.slice(0, n));
      timer = n > 0 ? setTimeout(() => del(n - 1), DELETE_MS) : setTimeout(() => type(1), TYPE_MS);
    };
    const type = (n: number) => {
      if (cancelled) return;
      setTyped(entry.to.slice(0, n));
      if (n < entry.to.length) timer = setTimeout(() => type(n + 1), TYPE_MS);
      else timer = setTimeout(() => { if (!cancelled) setTyped(null); }, TYPE_MS);
    };

    del(entry.from.length);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // tab.label in deps: a concurrent user rename must cancel the animation and show truth
  }, [tab.id, tab.label, reduced]);

  const animating = typed !== null;
  return (
    <span
      style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      aria-label={tab.label}
    >
      <span data-testid="thread-label-text">{animating ? typed : tab.label}</span>
      {animating && <span className="dispatch-caret" aria-hidden="true" />}
    </span>
  );
}
