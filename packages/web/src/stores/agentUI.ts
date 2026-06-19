import { create } from 'zustand';
import { useAgents } from './agents';

// Coordinates the agent UI that now lives inside the workspace: which agent is
// "focused" in the main pane, and the create/edit modal (opened from a project card).
interface AgentUI {
  focused: boolean;
  editing: { scheduleId: string | null; preset: string | null } | null;
  selectAgent: (id: string) => void;     // select + show its dashboard in the main pane
  openNew: (projectId: string) => void;  // open the create modal preset to a project
  openEdit: () => void;
  closeEdit: () => void;
  blur: () => void;                       // leave agent focus (e.g. a thread was selected)
}

export const useAgentUI = create<AgentUI>((set) => ({
  focused: false,
  editing: null,
  selectAgent: (id) => { void useAgents.getState().select(id); set({ focused: true }); },
  openNew: (projectId) => set({ editing: { scheduleId: null, preset: projectId } }),
  openEdit: () => set({ editing: { scheduleId: useAgents.getState().selectedId, preset: null } }),
  closeEdit: () => set({ editing: null }),
  blur: () => set({ focused: false }),
}));
