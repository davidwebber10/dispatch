import { useEffect, useState } from 'react';
import { create } from 'zustand';

type Status = 'connecting' | 'open' | 'closed';

export const useConnection = create<{ status: Status; everOpen: boolean; setStatus: (s: Status) => void }>((set) => ({
  status: 'connecting',
  // Has the events socket ever connected in this page? Before that, "connecting" is the first
  // connect at launch, not a reconnect.
  everOpen: false,
  setStatus: (status) => set((s) => ({ status, everOpen: s.everOpen || status === 'open' })),
}));

/** How long the connection may be down before the status says so (2026-11-05). */
export const STATUS_GRACE_MS = 1500;

export type ShownStatus = 'open' | 'connecting' | 'reconnecting' | 'closed';

/**
 * The status to SHOW: a drop shorter than STATUS_GRACE_MS (a quick reconnect after the app comes
 * back, a blip on the network) still reads as connected, so the header doesn't flicker
 * "Reconnecting…" on every resume. The first connect at launch reads "connecting", a later one
 * "reconnecting".
 */
export function useShownStatus(): ShownStatus {
  const status = useConnection((s) => s.status);
  const everOpen = useConnection((s) => s.everOpen);
  const down = status !== 'open';
  const [late, setLate] = useState(false);
  // Keyed on up/down, not the status itself: a long outage flips closed → connecting → closed on
  // every retry, and restarting the clock on each flip would never let the status show.
  useEffect(() => {
    if (!down) { setLate(false); return; }
    const t = setTimeout(() => setLate(true), STATUS_GRACE_MS);
    return () => clearTimeout(t);
  }, [down]);
  if (status === 'open' || !late) return 'open';
  if (status === 'closed') return 'closed';
  return everOpen ? 'reconnecting' : 'connecting';
}
