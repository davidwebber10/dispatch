import { create } from 'zustand';

export type View = 'workspace' | 'agents';
export type InspectorTab = 'details' | 'files';

export const useUI = create<{
  view: View;
  setView: (v: View) => void;
  inspectorTab: InspectorTab;
  setInspectorTab: (t: InspectorTab) => void;
}>((set) => ({
  view: 'workspace',
  setView: (view) => set({ view }),
  inspectorTab: 'details',
  setInspectorTab: (inspectorTab) => set({ inspectorTab }),
}));
