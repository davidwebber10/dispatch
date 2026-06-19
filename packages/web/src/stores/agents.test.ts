import { expect, test, vi, beforeEach, afterEach } from 'vitest';
import { useAgents } from './agents';
import { api } from '../api/client';

beforeEach(() => useAgents.setState({ schedules: [], runs: [], selectedId: null }));
afterEach(() => vi.restoreAllMocks());

test('loadSchedules populates schedules and selects the first', async () => {
  vi.spyOn(api, 'listSchedules').mockResolvedValue([{ id: 'a1', name: 'Triage' } as any]);
  vi.spyOn(api, 'listRuns').mockResolvedValue([{ id: 'r1', scheduleId: 'a1', status: 'succeeded' } as any]);
  await useAgents.getState().loadSchedules();
  expect(useAgents.getState().selectedId).toBe('a1');
  expect(useAgents.getState().runs.map((r) => r.id)).toEqual(['r1']);
});

test('agent:run-updated prepends a run for the selected schedule', () => {
  useAgents.setState({ selectedId: 'a1', runs: [{ id: 'r1', scheduleId: 'a1', status: 'working' } as any] });
  useAgents.getState().applyEvent({ type: 'agent:run-updated', run: { id: 'r1', scheduleId: 'a1', status: 'succeeded' } });
  expect(useAgents.getState().runs).toHaveLength(1);
  expect(useAgents.getState().runs[0].status).toBe('succeeded');
});

test('schedule-removed drops the schedule', () => {
  useAgents.setState({ schedules: [{ id: 'a1' } as any, { id: 'a2' } as any] });
  useAgents.getState().applyEvent({ type: 'agent:schedule-removed', scheduleId: 'a1' });
  expect(useAgents.getState().schedules.map((s) => s.id)).toEqual(['a2']);
});
