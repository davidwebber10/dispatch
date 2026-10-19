import { create } from 'zustand';

/** A doc to show: the project that owns it, its path, and the branch to read it from (null: the project's own checkout). */
export interface DocRef { project: string; path: string; branch: string | null }

interface S { open: DocRef | null; back: DocRef[]; show: (r: DocRef) => void; push: (r: DocRef) => void; pop: () => void; close: () => void }

/** The doc viewer's state (the viewer itself is Task 11). `show` starts fresh; `push` keeps a Back stack. */
export const useDocViewer = create<S>((set, get) => ({
  open: null,
  back: [],
  show: (r) => set({ open: r, back: [] }),
  push: (r) => { const cur = get().open; set({ open: r, back: cur ? [...get().back, cur] : get().back }); },
  pop: () => { const b = get().back; if (!b.length) return; set({ open: b[b.length - 1], back: b.slice(0, -1) }); },
  close: () => set({ open: null, back: [] }),
}));
