import { create } from 'zustand';
import { api } from '../api/client';
import type { Terminal } from '../api/types';
import type { ServerEvent } from '../api/events-socket';
import { useProjects } from './projects';

const STORAGE_KEY = 'dispatch:tabs';

interface TabsState {
  byProject: Record<string, Terminal[]>;
  openTabIds: string[];          // tabs open in the top tab bar, in order
  activeTabId: string | null;
  tabSession: Record<string, string>; // tabId -> sessionId, so open tabs survive a refresh
  loading: Record<string, boolean>;   // terminals that just started / reloaded (transient spinner)
  markLoading: (id: string) => void;
  loadTabs: (projectId: string) => Promise<void>;
  setActiveTab: (id: string) => void;                       // open + focus
  openTab: (id: string, background?: boolean) => void;       // open (optionally without switching)
  closeTab: (id: string) => void;
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
  loadTabs: async (projectId) => {
    const tabs = await api.listTerminals(projectId);
    const tabSession = { ...get().tabSession };
    for (const t of tabs) tabSession[t.id] = t.sessionId;
    set({ byProject: { ...get().byProject, [projectId]: tabs }, tabSession });
    persist(get());
  },
  openTab: (id, background = false) => {
    const { openTabIds, activeTabId, byProject } = get();
    const next = openTabIds.includes(id) ? openTabIds : [...openTabIds, id];
    const t = findTerminal(byProject, id);
    const tabSession = t ? { ...get().tabSession, [id]: t.sessionId } : get().tabSession;
    set({ openTabIds: next, activeTabId: background ? activeTabId : id, tabSession });
    if (!background && t) useProjects.getState().setActive(t.sessionId);   // follow the tab into its project
    persist(get());
  },
  setActiveTab: (id) => get().openTab(id, false),
  closeTab: (id) => {
    const { openTabIds, activeTabId, tabSession } = get();
    const idx = openTabIds.indexOf(id);
    const next = openTabIds.filter((x) => x !== id);
    const active = activeTabId === id ? (next[Math.min(idx, next.length - 1)] ?? null) : activeTabId;
    const ts = { ...tabSession }; delete ts[id];
    set({ openTabIds: next, activeTabId: active, tabSession: ts });
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
    const alive = wantIds.filter((id) => findTerminal(byProject, id));
    const active = wantActive && alive.includes(wantActive) ? wantActive : (alive[0] ?? null);
    set({ openTabIds: alive, activeTabId: active });
    persist(get());

    if (active) {
      const t = findTerminal(get().byProject, active);
      if (t) useProjects.getState().setActive(t.sessionId);
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
      get().closeTab(e.terminalId);
      if (typeof e.sessionId === 'string') void get().loadTabs(e.sessionId);
    } else if (e.type === 'session:tabs-changed' && typeof e.sessionId === 'string') {
      void get().loadTabs(e.sessionId);
    }
  },
}));
