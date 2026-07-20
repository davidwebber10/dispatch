import { useLayoutEffect, useRef, useState } from 'react';
import type { Terminal } from '../../api/types';
import { useTabs } from '../../stores/tabs';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';

const DELETE_MS = 25;
const TYPE_MS = 35;

type ConsumedEntry = { from: string; to: string } | null;

/**
 * The thread-row label. Normally renders `tab.label` verbatim; when the tabs store
 * has just observed this thread auto-name itself, it backspaces the old label away
 * and types the new one in. The store is always the truth — this is presentation
 * only, so an unmount mid-animation simply leaves the final label behind.
 */
export function ThreadLabel({ tab }: { tab: Terminal }) {
  // usePrefersReducedMotion resolves synchronously (its own lazy useState initializer),
  // so it's safe to read `reduced` below in the same render for the `typed` initializer.
  const reduced = usePrefersReducedMotion();

  // null means "not animating — show tab.label". Seeded synchronously (peeking the
  // store, not consuming it) rather than via an effect: a plain useState(null)
  // paints tab.label — the FINAL name, since the store already applied the rename
  // before this render — for one frame, then an effect flips it back to the old
  // label to start the backspace. That reads as "correct name -> snaps backward ->
  // retypes a name already seen." Computing the initial value here means the very
  // first paint is already the old label, matching usePrefersReducedMotion's own
  // lazy-initializer precedent (hooks/usePrefersReducedMotion.ts).
  const [typed, setTyped] = useState<string | null>(() => {
    const pending = useTabs.getState().autoNamed[tab.id];
    return pending && !reduced ? pending.from : null;
  });

  // Remembers the entry this component instance has already consumed, keyed by the
  // identity being animated (tab.id + tab.label). React 18 StrictMode double-invokes
  // effects in development (mount -> cleanup -> mount) without re-running render or
  // discarding refs, and consumeAutoName is consume-once: the first invoke would eat
  // the entry and start the timer chain, the simulated cleanup cancels it, and the
  // second (real) invoke would find nothing left and render with no animation at
  // all. Replaying the remembered entry on a same-key re-invoke makes consumption
  // idempotent for this instance without weakening the store's consume-once contract
  // (which other code relies on to prevent replays).
  const consumedRef = useRef<{ key: string; entry: ConsumedEntry } | null>(null);

  useLayoutEffect(() => {
    // useLayoutEffect (not useEffect) so the kickoff — and any correction it makes
    // to `typed` — happens before the browser paints, never after.
    // `reduced` is part of the key (not just tab.id + tab.label): without it, flipping the OS
    // reduced-motion preference from on -> off after a reduced-motion "animation" (an instant
    // swap, no timers) has already consumed its entry re-runs this effect with a key that still
    // matches, so the StrictMode-replay branch below hands back the same already-consumed entry
    // — except this time `reduced` is false, so the `|| reduced` guard no longer short-circuits
    // it, and the finished rename plays out as a full typewriter animation a second time. Keying
    // on `reduced` too makes that second run look like a fresh identity, so it falls through to
    // consumeAutoName() again, which correctly returns null (already consumed).
    const key = `${tab.id}:${tab.label}:${reduced}`;
    let entry: ConsumedEntry;
    if (consumedRef.current && consumedRef.current.key === key) {
      entry = consumedRef.current.entry;
    } else {
      // getState() rather than a selector: consuming must not re-subscribe this component.
      entry = useTabs.getState().consumeAutoName(tab.id);
      consumedRef.current = { key, entry };
    }

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
