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

// W1-G (2026-11-09): the virtual tab's label follows Settings > Agents > Control Plane > Name.
test('tabLabel of the virtual tab returns the saved coordinator name', async () => {
  const { tabLabel, dispatchTabId } = await import('./tabs');
  const { useSettings } = await import('./settings');
  const before = useSettings.getState().coordinatorName;
  useSettings.setState({ coordinatorName: 'Houston' });
  expect(tabLabel(dispatchTabId('p1'), {})).toBe('Houston');
  useSettings.setState({ coordinatorName: '   ' });
  expect(tabLabel(dispatchTabId('p1'), {})).toBe('Control Plane'); // a blank name falls back
  expect(tabLabel('missing', {})).toBe('tab');
  useSettings.setState({ coordinatorName: before });
});
