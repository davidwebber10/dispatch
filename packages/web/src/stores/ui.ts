import { create } from 'zustand';

export type View = 'workspace' | 'agents';

export const useUI = create<{ view: View; setView: (v: View) => void }>((set) => ({
  view: 'workspace',
  setView: (view) => set({ view }),
}));
