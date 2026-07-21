import { expect, test, vi, beforeEach } from 'vitest';
import { resyncAfterReconnect } from './resync';
import { useThreadStatus } from '../stores/threadStatus';
import { useProjects } from '../stores/projects';
import { useTabs } from '../stores/tabs';
import { api } from '../api/client';

beforeEach(() => {
  useThreadStatus.setState({ byTerminal: {} });
  useProjects.setState({ sessions: [], activeId: null });
  useTabs.setState({ byProject: {} });
  vi.restoreAllMocks();
});

test('drops the stale live-status overlay so a missed settle no longer pins a card as working', async () => {
  // A thread that finished while we were disconnected: the daemon settled its row to
  // 'waiting', but we never got the working→settled event, so live status is frozen 'working'.
  useThreadStatus.setState({ byTerminal: { t1: { status: 'working', threadStatus: 'working', activity: 'Running' } } });
  useProjects.setState({ sessions: [{ id: 'p1', name: 'Alpha' } as any] });
  vi.spyOn(api, 'listTerminals').mockResolvedValue([]);

  await resyncAfterReconnect();

  expect(useThreadStatus.getState().byTerminal).toEqual({});
});

test('re-pulls the authoritative rows for every known project', async () => {
  useProjects.setState({ sessions: [{ id: 'p1', name: 'Alpha' } as any, { id: 'p2', name: 'Beta' } as any] });
  const listTerminals = vi.spyOn(api, 'listTerminals').mockResolvedValue([]);

  await resyncAfterReconnect();

  expect(listTerminals).toHaveBeenCalledWith('p1');
  expect(listTerminals).toHaveBeenCalledWith('p2');
});

test('a failing project reload is swallowed so one dead project cannot abort the resync', async () => {
  useProjects.setState({ sessions: [{ id: 'gone', name: 'Gone' } as any, { id: 'ok', name: 'Ok' } as any] });
  const listTerminals = vi.spyOn(api, 'listTerminals').mockImplementation(async (id: string) => {
    if (id === 'gone') throw new Error('404');
    return [];
  });

  await expect(resyncAfterReconnect()).resolves.toBeUndefined();
  expect(listTerminals).toHaveBeenCalledWith('ok');
});
