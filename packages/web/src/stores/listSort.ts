import { create } from 'zustand';
import { AGENT_SORTS, DEFAULT_AGENT_SORT, DEFAULT_THREAD_SORT, THREAD_SORTS, type AgentSort, type ThreadSort } from '../lib/listSort';

export const LIST_SORT_KEY = 'dispatch:listSort';

interface Persisted { threads?: Record<string, ThreadSort>; agents?: Record<string, AgentSort>; v?: number }

/**
 * 2: the thread default became 'active' (2026-11-05). A saved 'custom' was usually never chosen —
 * it was the old default, or a drag switched to it — so it is dropped once, and that project
 * falls to the new default. Every other saved choice stays.
 */
const VERSION = 2;

// Mirrors the load/save idiom in stores/settings.ts.
function load(): Persisted {
  try {
    const v = localStorage.getItem(LIST_SORT_KEY);
    if (v == null) return {};
    const p = JSON.parse(v) as Persisted;
    if ((p.v ?? 1) < VERSION && p.threads) {
      p.threads = Object.fromEntries(Object.entries(p.threads).filter(([, s]) => s !== 'custom'));
      p.v = VERSION;
      save(p);
    }
    return p;
  } catch { return {}; }
}
function save(v: Persisted) { try { localStorage.setItem(LIST_SORT_KEY, JSON.stringify(v)); } catch { /* ignore */ } }

const THREAD_VALUES = THREAD_SORTS.map(([v]) => v);
const AGENT_VALUES = AGENT_SORTS.map(([v]) => v);

interface ListSortState {
  threads: Record<string, ThreadSort>;
  agents: Record<string, AgentSort>;
  threadSort: (projectId: string) => ThreadSort;
  agentSort: (projectId: string) => AgentSort;
  setThreadSort: (projectId: string, v: ThreadSort) => void;
  setAgentSort: (projectId: string, v: AgentSort) => void;
}

const saved = load();

export const useListSort = create<ListSortState>((set, get) => ({
  threads: saved.threads ?? {},
  agents: saved.agents ?? {},
  // Validate on read, not just on load: a hand-edited or older blob must not
  // hand a comparator a mode it doesn't implement.
  threadSort: (projectId) => {
    const v = get().threads[projectId];
    return v && THREAD_VALUES.includes(v) ? v : DEFAULT_THREAD_SORT;
  },
  agentSort: (projectId) => {
    const v = get().agents[projectId];
    return v && AGENT_VALUES.includes(v) ? v : DEFAULT_AGENT_SORT;
  },
  setThreadSort: (projectId, v) => {
    const threads = { ...get().threads, [projectId]: v };
    set({ threads });
    save({ threads, agents: get().agents, v: VERSION });
  },
  setAgentSort: (projectId, v) => {
    const agents = { ...get().agents, [projectId]: v };
    set({ agents });
    save({ threads: get().threads, agents, v: VERSION });
  },
}));
