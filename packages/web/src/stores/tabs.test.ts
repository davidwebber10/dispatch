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
