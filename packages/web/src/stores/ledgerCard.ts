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
  /** A ledger chip asked the card to open this item (Unit 9); the card clears it once it did. */
  focus: { projectId: string; seq: number } | null;
  /** A ledger chip of an item that is not on the card: the small popover at the click (Unit 9). */
  popover: { projectId: string; seq: number; x: number; y: number } | null;
  /**
   * The item whose source the section panel shows (titles and source panel spec 2026-10-09,
   * Unit 10): a click on a Source line sets it, and a click on another one replaces it.
   */
  sourcePanel: { projectId: string; seq: number } | null;
  setFocus: (focus: { projectId: string; seq: number } | null) => void;
  setPopover: (popover: { projectId: string; seq: number; x: number; y: number } | null) => void;
  setSourcePanel: (panel: { projectId: string; seq: number } | null) => void;
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
    focus: null,
    popover: null,
    sourcePanel: null,
    setFocus: (focus) => set({ focus }),
    setPopover: (popover) => set({ popover }),
    setSourcePanel: (sourcePanel) => set({ sourcePanel }),
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

/** The folded parts of the card that can open: the rules list and the sections below "Needs you now". */
export type LedgerFold = 'rules' | 'actions' | 'onDefaults' | 'decidedSince' | 'untriaged' | 'parked';

export const LEDGER_FOLDS_KEY = 'dispatch:ledgerCard:open';

function loadFolds(): Partial<Record<LedgerFold, boolean>> {
  try {
    const parsed = JSON.parse(localStorage.getItem(LEDGER_FOLDS_KEY) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Partial<Record<LedgerFold, boolean>>) : {};
  } catch { return {}; }
}

/**
 * Which parts of the card the user opened. Folded is the default (a count only), so only the
 * open ones are stored; the state is kept in local storage and is the same for every project, as
 * the sidebar shelves are (stores/sectionCollapse.ts).
 */
export const useLedgerFolds = create<{ open: Partial<Record<LedgerFold, boolean>>; setOpen: (fold: LedgerFold, v: boolean) => void }>((set, get) => ({
  open: loadFolds(),
  setOpen: (fold, v) => {
    const open = { ...get().open };
    if (v) open[fold] = true;
    else delete open[fold];
    set({ open });
    try { localStorage.setItem(LEDGER_FOLDS_KEY, JSON.stringify(open)); } catch { /* storage unavailable */ }
  },
}));
