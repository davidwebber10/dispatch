import { create } from 'zustand';
import { api } from '../api/client';
import type { AgentSchedule, AgentRun } from '../api/types';
import type { ServerEvent } from '../api/events-socket';

interface AgentsState {
  schedules: AgentSchedule[];
  runs: AgentRun[];          // runs for the selected schedule
  selectedId: string | null;
  loadSchedules: () => Promise<void>;
  select: (id: string) => Promise<void>;
  applyEvent: (e: ServerEvent) => void;
}

export const useAgents = create<AgentsState>((set, get) => ({
  schedules: [],
  runs: [],
  selectedId: null,
  loadSchedules: async () => {
    const schedules = await api.listSchedules();
    const selectedId = get().selectedId ?? schedules[0]?.id ?? null;
    set({ schedules, selectedId });
    if (selectedId) { set({ runs: await api.listRuns({ scheduleId: selectedId }) }); }
  },
  select: async (id) => {
    set({ selectedId: id, runs: [] });
    set({ runs: await api.listRuns({ scheduleId: id }) });
  },
  applyEvent: (e) => {
    if (e.type === 'agent:schedule-created' && e.schedule) {
      set({ schedules: [e.schedule as AgentSchedule, ...get().schedules] });
    } else if (e.type === 'agent:schedule-updated' && e.schedule) {
      const s = e.schedule as AgentSchedule;
      set({ schedules: get().schedules.map((x) => (x.id === s.id ? s : x)) });
    } else if (e.type === 'agent:schedule-removed') {
      set({ schedules: get().schedules.filter((x) => x.id !== e.scheduleId) });
    } else if ((e.type === 'agent:run-created' || e.type === 'agent:run-updated') && e.run) {
      const run = e.run as AgentRun;
      if (run.scheduleId === get().selectedId) {
        set({ runs: [run, ...get().runs.filter((r) => r.id !== run.id)] });
      }
    }
  },
}));
