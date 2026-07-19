import { create } from 'zustand';
import { api } from '../api/client';
import type { Terminal } from '../api/types';
import type { ServerEvent } from '../api/events-socket';
import { useProjects } from './projects';
import { clearDraft } from '../lib/fileDrafts';

const STORAGE_KEY = 'dispatch:tabs';

export const AUTO_NAME_TTL_MS = 3000;

/** A live default -> auto label transition, awaiting a mounted label to animate it. */
export interface AutoNameEntry { from: string; to: string; at: number }

interface TabsState {
  byProject: Record<string, Terminal[]>;
  openTabIds: string[];          // tabs open in the top tab bar, in order
  activeTabId: string | null;
  tabSession: Record<string, string>; // tabId -> sessionId, so open tabs survive a refresh
  loading: Record<string, boolean>;   // terminals that just started / reloaded (transient spinner)
  /** Tabs with unsaved edits — closing one prompts first. */
  dirtyTabs: Record<string, boolean>;
  autoNamed: Record<string, AutoNameEntry>;
  setTabDirty: (id: string, dirty: boolean) => void;
  markLoading: (id: string) => void;
  loadTabs: (projectId: string) => Promise<void>;
  consumeAutoName: (id: string) => { from: string; to: string } | null;
  reorder: (projectId: string, orderedIds: string[]) => Promise<void>;
  setPinned: (id: string, pinned: boolean) => Promise<void>;  // pin/unpin a thread (persisted in config.pinned)
  setAlertsEnabled: (id: string, enabled: boolean) => Promise<void>; // per-thread push alerts (config.alertsEnabled)
  setActiveTab: (id: string) => void;                       // open + focus
  openTab: (id: string, background?: boolean) => void;       // open (optionally without switching)
  openDispatch: (sessionId: string) => void;                 // open + focus the project's virtual Dispatch tab
  closeTab: (id: string, opts?: { force?: boolean }) => void;
  hydrate: () => Promise<void>;                              // restore open tabs after a page refresh
  applyEvent: (e: ServerEvent) => void;
}

export function findTerminal(byProject: Record<string, Terminal[]>, id: string): Terminal | undefined {
  for (const list of Object.values(byProject)) {
    const t = list.find((x) => x.id === id);
    if (t) return t;
  }
  return undefined;
}

/* ── Virtual "Dispatch" tab ──────────────────────────────────────────────
   The Dispatch (coordinator/overseer) surface opens as a tab in the main
   window, but it is NOT a backend terminal — it's a client-only virtual tab
   whose id encodes the project it belongs to (`dispatch:<sessionId>`). This
   keeps it out of `byProject` (so it never leaks into the sidebar thread list
   or status counts) while still flowing through the normal open/close/persist
   paths. One Dispatch tab per project. */
export const DISPATCH_PREFIX = 'dispatch:';
export const dispatchTabId = (sessionId: string): string => `${DISPATCH_PREFIX}${sessionId}`;
export const isDispatchTab = (id: string | null | undefined): boolean => !!id && id.startsWith(DISPATCH_PREFIX);
export const dispatchSessionId = (id: string): string => id.slice(DISPATCH_PREFIX.length);

/** Display label for a tab id — 'Control Plane' for the virtual tab, else the terminal's label. */
export function tabLabel(id: string, byProject: Record<string, Terminal[]>): string {
  if (isDispatchTab(id)) return 'Control Plane';
  return findTerminal(byProject, id)?.label ?? 'tab';
}

/** The project (session) id a tab belongs to — works for the virtual Dispatch tab too. */
export function tabProjectId(id: string, byProject: Record<string, Terminal[]>): string | undefined {
  if (isDispatchTab(id)) return dispatchSessionId(id);
  return findTerminal(byProject, id)?.sessionId;
}

function pruneAutoNamed(entries: Record<string, AutoNameEntry>, now: number): Record<string, AutoNameEntry> {
  const kept: Record<string, AutoNameEntry> = {};
  for (const [id, e] of Object.entries(entries)) if (now - e.at <= AUTO_NAME_TTL_MS) kept[id] = e;
  return kept;
}

/** A rename is animatable only when the daemon just switched this label from its default to a generated one. */
function detectAutoNames(prev: Terminal[] | undefined, next: Terminal[], now: number): Record<string, AutoNameEntry> {
  if (!prev) return {}; // first load for this project — nothing to diff, so a reload can never animate
  const byId = new Map(prev.map((t) => [t.id, t]));
  const found: Record<string, AutoNameEntry> = {};
  for (const n of next) {
    const p = byId.get(n.id);
    if (!p) continue;
    if ((p.labelSource ?? 'user') !== 'default') continue;
    if (n.labelSource !== 'auto') continue;
    if (p.label === n.label) continue;
    found[n.id] = { from: p.label, to: n.label, at: now };
  }
  return found;
}

// module scope, transient (deliberately not store state — it must not persist or trigger renders):
// tracks the most recent loadTabs() request per project so a superseded response can be
// discarded instead of applied.
const loadEpoch: Record<string, number> = {};

function persist(s: Pick<TabsState, 'openTabIds' | 'activeTabId' | 'tabSession'>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ openTabIds: s.openTabIds, activeTabId: s.activeTabId, tabSession: s.tabSession }));
  } catch { /* ignore */ }
}

export const useTabs = create<TabsState>((set, get) => ({
  loading: {},
  markLoading: (id) => {
    set({ loading: { ...get().loading, [id]: true } });
    setTimeout(() => {
      if (!get().loading[id]) return;
      const next = { ...get().loading };
      delete next[id];
      set({ loading: next });
    }, 5000);
  },
  byProject: {},
  openTabIds: [],
  activeTabId: null,
  tabSession: {},
  dirtyTabs: {},
  autoNamed: {},
  setTabDirty: (id, dirty) => {
    const next = { ...get().dirtyTabs };
    if (dirty) next[id] = true; else delete next[id];
    set({ dirtyTabs: next });
  },
  loadTabs: async (projectId) => {
    const epoch = (loadEpoch[projectId] = (loadEpoch[projectId] ?? 0) + 1);
    const tabs = await api.listTerminals(projectId);
    // If a newer loadTabs('projectId') call started after this one, its response — not this
    // one's — reflects reality. Applying a superseded response here would regress byProject to
    // a stale label, which a later ordinary refresh would then misread as a fresh default->auto
    // transition and replay an animation for a rename that already happened.
    if (loadEpoch[projectId] !== epoch) return;
    const now = Date.now();
    const prev = get().byProject[projectId];
    const tabSession = { ...get().tabSession };
    for (const t of tabs) tabSession[t.id] = t.sessionId;
    const autoNamed = { ...pruneAutoNamed(get().autoNamed, now), ...detectAutoNames(prev, tabs, now) };
    set({ byProject: { ...get().byProject, [projectId]: tabs }, tabSession, autoNamed });
    persist(get()); // note: persist() intentionally omits byProject and autoNamed
  },
  consumeAutoName: (id) => {
    const entry = get().autoNamed[id];
    if (!entry) return null;
    const rest = { ...get().autoNamed };
    delete rest[id];
    set({ autoNamed: rest });
    if (Date.now() - entry.at > AUTO_NAME_TTL_MS) return null;
    return { from: entry.from, to: entry.to };
  },
  reorder: async (projectId, orderedIds) => {
    const current = get().byProject[projectId] ?? [];
    const byId = new Map(current.map((t) => [t.id, t]));
    const reordered = orderedIds.map((id) => byId.get(id)).filter((t): t is NonNullable<typeof t> => !!t);
    // keep any rows not present in orderedIds (defensive) appended in their old order
    for (const t of current) if (!orderedIds.includes(t.id)) reordered.push(t);
    set({ byProject: { ...get().byProject, [projectId]: reordered } });
    try { await api.reorderTerminals(projectId, orderedIds); }
    catch (e) { console.error('useTabs.reorder: reorderTerminals failed, reverting', e); await get().loadTabs(projectId); }  // restore server truth on failure
  },
  setPinned: async (id, pinned) => {
    const t = findTerminal(get().byProject, id);
    if (!t) return;
    // The server PATCH replaces config wholesale — send the merged blob. Drop the
    // key entirely on unpin so configs don't accumulate `pinned: false` noise.
    const config = { ...t.config } as Record<string, unknown>;
    if (pinned) config.pinned = true; else delete config.pinned;
    const byProject = { ...get().byProject };
    byProject[t.sessionId] = (byProject[t.sessionId] ?? []).map((x) => (x.id === id ? { ...x, config } : x));
    set({ byProject }); // optimistic — the row moves instantly
    try { await api.updateTerminal(id, { config }); }
    catch (e) { console.error('useTabs.setPinned: updateTerminal failed, reverting', e); await get().loadTabs(t.sessionId); }
  },
  setAlertsEnabled: async (id, enabled) => {
    const t = findTerminal(get().byProject, id);
    if (!t) return;
    // Dedicated merge endpoint (NOT the generic PATCH — that clobbers config);
    // optimistic local merge so the bell flips instantly.
    const config = { ...t.config } as Record<string, unknown>;
    if (enabled) config.alertsEnabled = true; else delete config.alertsEnabled;
    const byProject = { ...get().byProject };
    byProject[t.sessionId] = (byProject[t.sessionId] ?? []).map((x) => (x.id === id ? { ...x, config } : x));
    set({ byProject });
    try { await api.setTerminalAlerts(id, enabled); }
    catch (e) { console.error('useTabs.setAlertsEnabled: failed, reverting', e); await get().loadTabs(t.sessionId); }
  },
  openTab: (id, background = false) => {
    const { openTabIds, activeTabId, byProject } = get();
    const next = openTabIds.includes(id) ? openTabIds : [...openTabIds, id];
    const t = findTerminal(byProject, id);
    // Virtual Dispatch tabs have no backend terminal; fall back to the sessionId
    // recorded in tabSession so they still follow into their project + persist.
    const sessionId = t?.sessionId ?? get().tabSession[id];
    const tabSession = sessionId ? { ...get().tabSession, [id]: sessionId } : get().tabSession;
    set({ openTabIds: next, activeTabId: background ? activeTabId : id, tabSession });
    if (!background && sessionId) useProjects.getState().setActive(sessionId);   // follow the tab into its project
    persist(get());
  },
  setActiveTab: (id) => get().openTab(id, false),
  openDispatch: (sessionId) => {
    const id = dispatchTabId(sessionId);
    // Seed the session mapping first so openTab can follow it into the project.
    set({ tabSession: { ...get().tabSession, [id]: sessionId } });
    get().openTab(id, false);
  },
  closeTab: (id, opts) => {
    // Single choke point for EVERY close path (tab bar, grouped tab bar, close-group), so a new
    // call site can't accidentally bypass the guard. `force` is for the server-initiated
    // terminal:removed event, where the file is already gone and prompting would be absurd.
    if (!opts?.force && get().dirtyTabs[id]) {
      if (!window.confirm('This file has unsaved changes. Close the tab and discard them?')) return;
    }
    // Past the guard the tab is really going away, so its unsaved draft goes too — reopening the
    // file must show what is on disk, not resurrect edits the user just chose to discard.
    clearDraft(id);
    const { openTabIds, activeTabId, tabSession } = get();
    const idx = openTabIds.indexOf(id);
    const next = openTabIds.filter((x) => x !== id);
    const active = activeTabId === id ? (next[Math.min(idx, next.length - 1)] ?? null) : activeTabId;
    const ts = { ...tabSession }; delete ts[id];
    const dirtyTabs = { ...get().dirtyTabs }; delete dirtyTabs[id];
    set({ openTabIds: next, activeTabId: active, tabSession: ts, dirtyTabs });
    persist(get());
  },
  hydrate: async () => {
    let saved: { openTabIds?: unknown; activeTabId?: unknown; tabSession?: Record<string, string> } | null = null;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { /* ignore */ }
    if (!saved || !Array.isArray(saved.openTabIds) || !saved.openTabIds.length) return;
    const wantIds = saved.openTabIds as string[];
    const tabSession = (saved.tabSession ?? {}) as Record<string, string>;
    const wantActive = typeof saved.activeTabId === 'string' ? saved.activeTabId : null;
    set({ openTabIds: wantIds, activeTabId: wantActive, tabSession });

    // Reload the terminals for every project that had an open tab, then drop any that vanished.
    const sessionIds = [...new Set(wantIds.map((id) => tabSession[id]).filter(Boolean))];
    await Promise.all(sessionIds.map((sid) => get().loadTabs(sid).catch(() => { /* project gone */ })));

    const { byProject } = get();
    // Keep virtual Dispatch tabs (no backend terminal) alongside surviving real tabs.
    const alive = wantIds.filter((id) => isDispatchTab(id) || findTerminal(byProject, id));
    const active = wantActive && alive.includes(wantActive) ? wantActive : (alive[0] ?? null);
    set({ openTabIds: alive, activeTabId: active });
    persist(get());

    if (active) {
      const sid = tabProjectId(active, get().byProject);
      if (sid) useProjects.getState().setActive(sid);
    }
  },
  applyEvent: (e) => {
    if (e.type === 'terminal:status' || e.type === 'terminal:exit') {
      const status = e.type === 'terminal:exit' ? 'waiting' : (e.status as Terminal['status']);
      const byProject = { ...get().byProject };
      for (const pid of Object.keys(byProject)) {
        byProject[pid] = byProject[pid].map((t) => (t.id === e.terminalId ? { ...t, status } : t));
      }
      set({ byProject });
    } else if (e.type === 'terminal:removed' && typeof e.terminalId === 'string') {
      get().closeTab(e.terminalId, { force: true });
      if (typeof e.sessionId === 'string') void get().loadTabs(e.sessionId);
    } else if (e.type === 'session:tabs-changed' && typeof e.sessionId === 'string') {
      void get().loadTabs(e.sessionId);
    }
  },
}));
