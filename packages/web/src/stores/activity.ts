import { create } from 'zustand';
import type { ServerEvent } from '../api/events-socket';

export interface Activity {
  activity?: string;
  model?: string;
  cost?: string;
  tokens?: string;
  percentage?: string;
  context?: string;
}

interface ActivityState {
  byTerminal: Record<string, Activity>;
  applyEvent: (e: ServerEvent) => void;
}

export const useActivity = create<ActivityState>((set, get) => ({
  byTerminal: {},
  applyEvent: (e) => {
    if (e.type === 'terminal:activity' && typeof e.terminalId === 'string') {
      const next: Activity = {
        activity: e.activity as string,
        model: e.model as string | undefined,
        cost: e.cost as string | undefined,
        tokens: e.tokens as string | undefined,
        percentage: e.percentage as string | undefined,
        context: e.context as string | undefined,
      };
      set({ byTerminal: { ...get().byTerminal, [e.terminalId]: next } });
    }
  },
}));
