import { create } from 'zustand';

export type ThreadMode = 'normal' | 'expert';

/** Per-thread view choice (in-memory; defaults applied by the caller). 'normal'=View (read-only), 'expert'=Terminal. */
export const useThreadMode = create<{
  modes: Record<string, ThreadMode>;
  set: (terminalId: string, mode: ThreadMode) => void;
}>((set) => ({
  modes: {},
  set: (terminalId, mode) => set((s) => ({ modes: { ...s.modes, [terminalId]: mode } })),
}));
