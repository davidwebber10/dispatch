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

// W1-F: a status event must touch one project's array only, so a selector on another
// project (and the memoized ProjectCard behind it) sees the same reference.
test('a status event changes only the array of the project that holds the terminal (identity check)', () => {
  const a = [{ id: 'a1', sessionId: 'A', status: 'waiting' } as any, { id: 'a2', sessionId: 'A', status: 'waiting' } as any];
  const b = [{ id: 'b1', sessionId: 'B', status: 'waiting' } as any];
  useTabs.setState({ byProject: { A: a, B: b }, activeTabId: null });
  useTabs.getState().applyEvent({ type: 'terminal:status', terminalId: 'a1', status: 'working' });
  const next = useTabs.getState().byProject;
  expect(next.B).toBe(b);                 // the other project's array keeps its identity
  expect(next.A).not.toBe(a);             // the holder's array is replaced
  expect(next.A[0].status).toBe('working');
  expect(next.A[0]).not.toBe(a[0]);       // the one row is replaced
  expect(next.A[1]).toBe(a[1]);           // its sibling row keeps its identity
});

test('an equal status changes nothing (the state object is the same)', () => {
  useTabs.setState({ byProject: { A: [{ id: 'a1', sessionId: 'A', status: 'working' } as any] }, activeTabId: null });
  const before = useTabs.getState();
  const listener = vi.fn();
  const off = useTabs.subscribe(listener);
  useTabs.getState().applyEvent({ type: 'terminal:status', terminalId: 'a1', status: 'working' });
  useTabs.getState().applyEvent({ type: 'terminal:status', terminalId: 'unknown', status: 'working' });
  off();
  expect(useTabs.getState()).toBe(before);
  expect(listener).not.toHaveBeenCalled();
});

test('terminal:exit sets waiting on the one row and leaves other projects alone', () => {
  const b = [{ id: 'b1', sessionId: 'B', status: 'working' } as any];
  useTabs.setState({ byProject: { A: [{ id: 'a1', sessionId: 'A', status: 'working' } as any], B: b }, activeTabId: null });
  useTabs.getState().applyEvent({ type: 'terminal:exit', terminalId: 'a1' });
  expect(useTabs.getState().byProject.A[0].status).toBe('waiting');
  expect(useTabs.getState().byProject.B).toBe(b);
});
