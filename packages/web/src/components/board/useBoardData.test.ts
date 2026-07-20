import { renderHook, waitFor } from '@testing-library/react';
import { expect, test, vi, beforeEach } from 'vitest';
import { useBoardData } from './useBoardData';
import { useProjects } from '../../stores/projects';
import { useTabs } from '../../stores/tabs';
import { useThreadStatus } from '../../stores/threadStatus';
import { api } from '../../api/client';

beforeEach(() => {
  useProjects.setState({ sessions: [], activeId: null });
  useTabs.setState({ byProject: {} });
  useThreadStatus.setState({ byTerminal: {} });
  vi.restoreAllMocks();
});

test('loads every project on mount (the cross-project load pattern) and folds terminals through boardColumn', async () => {
  useProjects.setState({ sessions: [{ id: 'p1', name: 'Alpha' } as any, { id: 'p2', name: 'Beta' } as any] });
  const listTerminals = vi.spyOn(api, 'listTerminals').mockImplementation(async (projectId: string) => {
    if (projectId === 'p1') return [{ id: 't1', label: 'one', status: 'needs_input', config: {}, archivedAt: null } as any];
    return [{ id: 't2', label: 'two', status: 'working', config: {}, archivedAt: null } as any];
  });

  const { result } = renderHook(() => useBoardData(null));

  expect(result.current.loading).toBe(true);
  await waitFor(() => expect(result.current.loading).toBe(false));

  expect(listTerminals).toHaveBeenCalledWith('p1');
  expect(listTerminals).toHaveBeenCalledWith('p2');
  expect(result.current.columns.needs_help.map((c) => c.terminalId)).toEqual(['t1']);
  expect(result.current.columns.working.map((c) => c.terminalId)).toEqual(['t2']);
  expect(result.current.projects).toEqual([{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }]);
});

// A load that never settles — these two tests assert on state seeded directly into the
// stores, and a resolved mock would otherwise race the mount-time loadTabs() call and
// overwrite it with an empty list.
const neverSettles = () => new Promise<never>(() => { /* never resolves */ });

test('projectFilter scopes the board down to a single project', async () => {
  useProjects.setState({ sessions: [{ id: 'p1', name: 'Alpha' } as any, { id: 'p2', name: 'Beta' } as any] });
  useTabs.setState({
    byProject: {
      p1: [{ id: 't1', label: 'one', status: 'working', config: {}, archivedAt: null } as any],
      p2: [{ id: 't2', label: 'two', status: 'working', config: {}, archivedAt: null } as any],
    },
  });
  vi.spyOn(api, 'listTerminals').mockImplementation(neverSettles);

  const { result } = renderHook(() => useBoardData('p1'));

  expect(result.current.columns.working.map((c) => c.terminalId)).toEqual(['t1']);
});

test('live status from useThreadStatus overrides a stale persisted row', async () => {
  useProjects.setState({ sessions: [{ id: 'p1', name: 'Alpha' } as any] });
  useTabs.setState({ byProject: { p1: [{ id: 't1', label: 'one', status: 'waiting', config: {}, archivedAt: null } as any] } });
  useThreadStatus.setState({ byTerminal: { t1: { status: 'working', threadStatus: 'working' } } });
  vi.spyOn(api, 'listTerminals').mockImplementation(neverSettles);

  const { result } = renderHook(() => useBoardData(null));

  expect(result.current.columns.working.map((c) => c.terminalId)).toEqual(['t1']);
  expect(result.current.columns.resting).toEqual([]);
});
