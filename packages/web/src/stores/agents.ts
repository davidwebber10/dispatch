import { create } from 'zustand';
import { api } from '../api/client';
import type { AgentSchedule, AgentRun, RunStep } from '../api/types';
import type { ServerEvent } from '../api/events-socket';

interface AgentsState {
  schedules: AgentSchedule[];
  runs: AgentRun[];          // runs for the selected schedule
  selectedId: string | null;
  runSteps: Record<string, RunStep[]>; // live + backfilled steps, keyed by runId
  loadSchedules: () => Promise<void>;
  select: (id: string) => Promise<void>;
  loadRunSteps: (runId: string) => Promise<void>;
  applyEvent: (e: ServerEvent) => void;
}

function sameStep(a: RunStep | undefined, b: RunStep): boolean {
  return !!a && a.kind === b.kind && a.title === b.title && a.detail === b.detail;
}

export const useAgents = create<AgentsState>((set, get) => ({
  schedules: [],
  runs: [],
  selectedId: null,
  runSteps: {},
  loadRunSteps: async (runId) => {
    const { steps } = await api.runEvents(runId);
    // Merge backfill under any live steps that arrived during the fetch.
    const live = get().runSteps[runId] ?? [];
    const merged = live.length > steps.length ? live : steps;
    set({ runSteps: { ...get().runSteps, [runId]: merged } });
  },
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
    } else if (e.type === 'agent:run-step' && typeof e.runId === 'string' && e.step) {
      const runId = e.runId;
      const step = e.step as RunStep;
      const cur = get().runSteps[runId] ?? [];
      if (sameStep(cur[cur.length - 1], step)) return; // guard immediate dup vs backfill
      set({ runSteps: { ...get().runSteps, [runId]: [...cur, step] } });
    }
  },
}));
