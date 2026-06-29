import { create } from 'zustand';
import { useTabs } from '../../stores/tabs';
import {
  type Group, type PaneNode,
  defaultLayout, addLeaf, removeLeaf, setRatio as setRatioNode,
  leafCount, leafTabIds, MAX_PANES,
} from './types';

const STORAGE_KEY = 'dispatch:groups';

interface GroupsState {
  groups: Record<string, Group>;
  tabGroup: Record<string, string>; // tabId -> groupId
  /** Create a group from two individual tabs (default left|right layout). Returns the new group id. */
  merge: (sessionId: string, tabIdA: string, tabIdB: string) => string;
  /** Add an individual tab into an existing group at an optional target block (rebuilds to the next default shape). */
  addToGroup: (groupId: string, tabId: string, targetBlockIndex?: number) => void;
  /** Dissolve a group — its tabs become individual again (tabs stay open). */
  unmerge: (groupId: string) => void;
  /** Close every tab in the group (calls useTabs.closeTab) and remove the group. */
  closeGroup: (groupId: string) => void;
  /** Remove one pane from the group (tab stays open as an individual). Dissolves the group if <=1 leaf remains. */
  removeFromGroup: (groupId: string, tabId: string) => void;
  /** Set a divider ratio (clamped .15–.85). `path` addresses the split node (see types.setRatio). */
  setRatio: (groupId: string, path: string, ratio: number) => void;
  /** Replace a group's layout wholesale (used by reorganize-drag drops). */
  reorganize: (groupId: string, newLayout: PaneNode) => void;
}

function genId(): string {
  try { const id = globalThis.crypto?.randomUUID?.(); if (id) return id; } catch { /* ignore */ }
  return 'g-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function persist(s: Pick<GroupsState, 'groups' | 'tabGroup'>) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ groups: s.groups, tabGroup: s.tabGroup })); } catch { /* ignore */ }
}

function load(): { groups: Record<string, Group>; tabGroup: Record<string, string> } {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (raw && typeof raw === 'object' && raw.groups && raw.tabGroup) {
      return { groups: raw.groups as Record<string, Group>, tabGroup: raw.tabGroup as Record<string, string> };
    }
  } catch { /* ignore */ }
  return { groups: {}, tabGroup: {} };
}

/** Rebuild a tabId->groupId index for one group's current leaves. */
function indexGroup(tabGroup: Record<string, string>, group: Group): Record<string, string> {
  const next = { ...tabGroup };
  for (const id of leafTabIds(group.layout)) next[id] = group.id;
  return next;
}

const initial = load();

export const useGroups = create<GroupsState>((set, get) => ({
  groups: initial.groups,
  tabGroup: initial.tabGroup,

  merge: (sessionId, tabIdA, tabIdB) => {
    if (tabIdA === tabIdB) return get().tabGroup[tabIdA] ?? '';
    const id = genId();
    const group: Group = { id, sessionId, layout: defaultLayout([tabIdA, tabIdB]) };
    const groups = { ...get().groups, [id]: group };
    const tabGroup = { ...get().tabGroup, [tabIdA]: id, [tabIdB]: id };
    set({ groups, tabGroup });
    persist(get());
    return id;
  },

  addToGroup: (groupId, tabId, targetBlockIndex) => {
    const g = get().groups[groupId];
    if (!g) return;
    if (leafCount(g.layout) >= MAX_PANES) return;
    if (leafTabIds(g.layout).includes(tabId)) return;
    const layout = addLeaf(g.layout, tabId, targetBlockIndex);
    const group: Group = { ...g, layout };
    const groups = { ...get().groups, [groupId]: group };
    const tabGroup = { ...get().tabGroup, [tabId]: groupId };
    set({ groups, tabGroup });
    persist(get());
  },

  unmerge: (groupId) => {
    const g = get().groups[groupId];
    if (!g) return;
    const groups = { ...get().groups };
    delete groups[groupId];
    const tabGroup = { ...get().tabGroup };
    for (const id of leafTabIds(g.layout)) if (tabGroup[id] === groupId) delete tabGroup[id];
    set({ groups, tabGroup });
    persist(get());
  },

  closeGroup: (groupId) => {
    const g = get().groups[groupId];
    if (!g) return;
    const ids = leafTabIds(g.layout);
    const groups = { ...get().groups };
    delete groups[groupId];
    const tabGroup = { ...get().tabGroup };
    for (const id of ids) if (tabGroup[id] === groupId) delete tabGroup[id];
    set({ groups, tabGroup });
    persist(get());
    for (const id of ids) useTabs.getState().closeTab(id);
  },

  removeFromGroup: (groupId, tabId) => {
    const g = get().groups[groupId];
    if (!g) return;
    const layout = removeLeaf(g.layout, tabId);
    const tabGroup = { ...get().tabGroup };
    delete tabGroup[tabId];
    // Group must keep >= 2 panes; dissolve if removing left 0 or 1 leaf.
    if (!layout || leafCount(layout) <= 1) {
      const groups = { ...get().groups };
      delete groups[groupId];
      if (layout) for (const id of leafTabIds(layout)) delete tabGroup[id]; // survivor becomes individual
      set({ groups, tabGroup });
      persist(get());
      return;
    }
    const groups = { ...get().groups, [groupId]: { ...g, layout } };
    set({ groups, tabGroup });
    persist(get());
  },

  setRatio: (groupId, path, ratio) => {
    const g = get().groups[groupId];
    if (!g) return;
    const r = Math.max(0.15, Math.min(0.85, ratio));
    const layout = setRatioNode(g.layout, path, r);
    set({ groups: { ...get().groups, [groupId]: { ...g, layout } } });
    persist(get());
  },

  reorganize: (groupId, newLayout) => {
    const g = get().groups[groupId];
    if (!g) return;
    const group: Group = { ...g, layout: newLayout };
    const tabGroup = indexGroup(get().tabGroup, group);
    set({ groups: { ...get().groups, [groupId]: group }, tabGroup });
    persist(get());
  },
}));

/** The group a tab currently belongs to, if any. */
export function groupForTab(tabId: string): Group | undefined {
  const { tabGroup, groups } = useGroups.getState();
  const gid = tabGroup[tabId];
  return gid ? groups[gid] : undefined;
}
