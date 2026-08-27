import { create } from 'zustand';

export const SECTION_COLLAPSE_KEY = 'dispatch:sectionCollapse';

/**
 * Which sidebar shelves a project card has closed, keyed `${projectId}:${section}`.
 *
 * Deliberately persisted, unlike the per-card "Show N more" expansion in ProjectCard:
 * that one reveals a capped list and the cap is the steady state, so it resets. Closing
 * a shelf is the opposite — an explicit "I don't want to look at this" that should
 * survive a refresh, and re-closing FILES on every reload would make the control useless.
 *
 * Absent key = open. Storing only the closed shelves keeps the blob small and makes a
 * missing/corrupt entry fail open, which is the state that matches today's UI.
 */
type Collapsed = Record<string, boolean>;

function load(): Collapsed {
  try {
    const v = localStorage.getItem(SECTION_COLLAPSE_KEY);
    if (v == null) return {};
    const parsed = JSON.parse(v) as unknown;
    // A hand-edited or older blob must not hand the UI a non-object.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Collapsed;
  } catch { return {}; }
}
function save(v: Collapsed) { try { localStorage.setItem(SECTION_COLLAPSE_KEY, JSON.stringify(v)); } catch { /* ignore */ } }

const key = (projectId: string, section: string) => `${projectId}:${section}`;

interface SectionCollapseState {
  collapsed: Collapsed;
  isCollapsed: (projectId: string, section: string) => boolean;
  setCollapsed: (projectId: string, section: string, v: boolean) => void;
  toggle: (projectId: string, section: string) => void;
}

export const useSectionCollapse = create<SectionCollapseState>((set, get) => ({
  collapsed: load(),
  isCollapsed: (projectId, section) => get().collapsed[key(projectId, section)] === true,
  setCollapsed: (projectId, section, v) => {
    const next = { ...get().collapsed };
    // Drop rather than store `false`: absent already means open, and pruning keeps a
    // long-lived blob from accumulating an entry per project the user merely toggled.
    if (v) next[key(projectId, section)] = true;
    else delete next[key(projectId, section)];
    set({ collapsed: next });
    save(next);
  },
  toggle: (projectId, section) => {
    get().setCollapsed(projectId, section, !get().isCollapsed(projectId, section));
  },
}));
