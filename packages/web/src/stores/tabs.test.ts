import { expect, test, vi, beforeEach } from 'vitest';
import { useTabs } from './tabs';
import { api } from '../api/client';

beforeEach(() => {
  useTabs.setState({ byProject: {}, activeTabId: null });
  vi.restoreAllMocks();
});

test('loadTabs stores terminals under the project id', async () => {
  vi.spyOn(api, 'listTerminals').mockResolvedValue([{ id: 't1', sessionId: 's1' } as any]);
  await useTabs.getState().loadTabs('s1');
  expect(useTabs.getState().byProject['s1'].map(t => t.id)).toEqual(['t1']);
});

test('applyEvent terminal:status updates the matching terminal', () => {
  useTabs.setState({ byProject: { s1: [{ id: 't1', status: 'waiting' } as any] }, activeTabId: null });
  useTabs.getState().applyEvent({ type: 'terminal:status', terminalId: 't1', status: 'working' });
  expect(useTabs.getState().byProject['s1'][0].status).toBe('working');
});

test('setPinned merges the flag into config and PATCHes the full config', async () => {
  useTabs.setState({ byProject: { s1: [{ id: 't1', sessionId: 's1', config: { transport: 'structured' } } as any] } });
  const patch = vi.spyOn(api, 'updateTerminal').mockResolvedValue({} as any);
  await useTabs.getState().setPinned('t1', true);
  // updateTab on the server REPLACES config, so the merged blob must be sent
  expect(patch).toHaveBeenCalledWith('t1', { config: { transport: 'structured', pinned: true } });
  expect((useTabs.getState().byProject['s1'][0].config as any).pinned).toBe(true);
});

test('setPinned(false) clears the flag and reverts optimistic state on failure', async () => {
  useTabs.setState({ byProject: { s1: [{ id: 't1', sessionId: 's1', config: { pinned: true } } as any] } });
  vi.spyOn(api, 'updateTerminal').mockRejectedValue(new Error('offline'));
  vi.spyOn(api, 'listTerminals').mockResolvedValue([{ id: 't1', sessionId: 's1', config: { pinned: true } } as any]);
  await useTabs.getState().setPinned('t1', false);
  // failed PATCH → reloaded from server truth, still pinned
  expect((useTabs.getState().byProject['s1'][0].config as any).pinned).toBe(true);
});
