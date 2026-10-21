import { create } from 'zustand';

/**
 * A doc to show: the project that owns it, its path, the branch to read it from (null: the project's
 * own checkout), and the worktree whose copy to read, by its path in the project (`.worktrees/x` or
 * `.claude/worktrees/x`). A named copy wins over the main checkout. `origin` is the thread whose
 * message opened it (its own viewer shows it); none: Chat's viewer.
 */
export interface DocRef { project: string; path: string; branch: string | null; worktree?: string | null; origin?: string | null }

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
