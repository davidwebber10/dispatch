import { create } from 'zustand';

/** Top-level surface for the active project: Operator (hands-on threads/terminals)
 *  vs Overseer (the management / mission-control view). Persisted across reloads. */
export type ViewMode = 'operator' | 'overseer';

const KEY = 'dispatch:viewMode';
function load(): ViewMode {
  try { return localStorage.getItem(KEY) === 'overseer' ? 'overseer' : 'operator'; } catch { return 'operator'; }
}

export const useViewMode = create<{ mode: ViewMode; set: (m: ViewMode) => void; toggle: () => void }>((set, get) => ({
  mode: load(),
  set: (mode) => { try { localStorage.setItem(KEY, mode); } catch { /* ignore */ } set({ mode }); },
  toggle: () => get().set(get().mode === 'operator' ? 'overseer' : 'operator'),
}));
