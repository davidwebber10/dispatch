import { useEffect } from 'react';
import { create } from 'zustand';
import { api } from '../api/client';
import type { LedgerCard } from '../api/types';
import type { ServerEvent } from '../api/events-socket';

/**
 * The pinned card (pinned card spec 2026-10-08, Unit 6): one decision card per project, as the
 * daemon computes it (GET /api/sessions/:id/ledger/card).
 *
 * A project's card loads when the Control Plane screen shows the project (useLedgerCardSync),
 * again on every `ledger:changed` event for it (the one events socket in App.tsx routes it here),
 * and again after the socket reconnects (resyncAfterReconnect), since an event missed while the
 * socket was down never replays. A project the screen never showed is never fetched.
 *
 * A reload keeps the last good card on screen; a failed load keeps it too and sets `error`, so a
 * daemon restart shows the old card with the load error rather than an empty one.
 */
export interface LedgerCardEntry {
  card: LedgerCard | null;
  loading: boolean;
  error: string | null;
  /** The newest load for this project; an older response that lands later is dropped. */
  request: number;
}

interface LedgerCardState {
  byProject: Record<string, LedgerCardEntry>;
  load: (projectId: string) => Promise<void>;
  /** `ledger:changed` → load that project again, if the screen has shown it. */
  applyEvent: (e: ServerEvent) => void;
  /** Load every card the screen has shown (after a reconnect). */
  reloadAll: () => Promise<void>;
}

const EMPTY: LedgerCardEntry = { card: null, loading: false, error: null, request: 0 };
let lastRequest = 0;

export const useLedgerCard = create<LedgerCardState>((set, get) => {
  const patch = (projectId: string, p: Partial<LedgerCardEntry>) =>
    set((s) => ({ byProject: { ...s.byProject, [projectId]: { ...(s.byProject[projectId] ?? EMPTY), ...p } } }));
  return {
    byProject: {},
    load: async (projectId) => {
      const request = ++lastRequest;
      patch(projectId, { loading: true, request });
      const current = () => get().byProject[projectId]?.request === request;
      try {
        const card = await api.getLedgerCard(projectId);
        if (current()) patch(projectId, { card, loading: false, error: null });
      } catch (e) {
        if (current()) patch(projectId, { loading: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
    applyEvent: (e) => {
      if (e.type !== 'ledger:changed' || typeof e.sessionId !== 'string') return;
      if (get().byProject[e.sessionId]) void get().load(e.sessionId);
    },
    reloadAll: async () => {
      await Promise.all(Object.keys(get().byProject).map((id) => get().load(id)));
    },
  };
});

/** One project's card entry (a stable empty entry for a project that never loaded). */
export function useLedgerCardEntry(projectId: string | null): LedgerCardEntry {
  return useLedgerCard((s) => (projectId ? s.byProject[projectId] : undefined) ?? EMPTY);
}

/** Load the card of the project the Control Plane screen shows, and again when it shows another. */
export function useLedgerCardSync(projectId: string | null): void {
  useEffect(() => {
    if (projectId) void useLedgerCard.getState().load(projectId);
  }, [projectId]);
}
