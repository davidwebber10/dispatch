import { expect, test, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTabs, findTerminal } from './tabs';
import { useProjectTabs, useTerminal, useTerminalStatus, useTerminalLabel, useProjectIndicator, useTerminalProjectId, useTabProjectId, lookupTerminal } from './tabsSelectors';

const term = (id: string, sessionId: string, status = 'waiting') => ({ id, sessionId, status, label: id, type: 'shell', config: {} }) as any;

beforeEach(() => {
  useTabs.setState({
    byProject: { A: [term('a1', 'A'), term('a2', 'A')], B: [term('b1', 'B')] },
    activeTabId: null, loading: {},
  });
});

/** Renders the hook and counts how often React rendered it. */
function counted<T>(hook: () => T) {
  let renders = 0;
  const r = renderHook(() => { renders++; return hook(); });
  return { result: r.result, renders: () => renders };
}
const status = (terminalId: string, s: string) => act(() => { useTabs.getState().applyEvent({ type: 'terminal:status', terminalId, status: s }); });

test('useProjectTabs for project B does not notify when a thread in project A changes', () => {
  const b = counted(() => useProjectTabs('B'));
  const a = counted(() => useProjectTabs('A'));
  const before = { a: a.renders(), b: b.renders() };
  const listB = b.result.current;
  status('a1', 'working');
  expect(b.renders()).toBe(before.b);
  expect(b.result.current).toBe(listB);
  expect(a.renders()).toBe(before.a + 1);
  expect(a.result.current[0].status).toBe('working');
});

test('useProjectTabs answers one stable empty list for an unknown project', () => {
  const h = counted(() => useProjectTabs('nope'));
  const first = h.result.current;
  status('a1', 'working');
  expect(h.result.current).toBe(first);
  expect(h.renders()).toBe(1);
});

test('useTerminal and useTerminalStatus notify for their own terminal only', () => {
  const t = counted(() => useTerminal('b1'));
  const s = counted(() => useTerminalStatus('b1'));
  status('a1', 'working');
  expect(t.renders()).toBe(1);
  expect(s.renders()).toBe(1);
  status('b1', 'working');
  expect(t.result.current?.status).toBe('working');
  expect(s.result.current).toBe('working');
  expect(t.renders()).toBe(2);
  expect(s.renders()).toBe(2);
});

test('useTerminalLabel and useTerminalProjectId do not notify on a status change of their own terminal', () => {
  const label = counted(() => useTerminalLabel('a1'));
  const project = counted(() => useTerminalProjectId('a1'));
  status('a1', 'working');
  expect(label.result.current).toBe('a1');
  expect(project.result.current).toBe('A');
  expect(label.renders()).toBe(1);
  expect(project.renders()).toBe(1);
});

test('useTabProjectId answers the project of the virtual Dispatch tab', () => {
  expect(renderHook(() => useTabProjectId('dispatch:B')).result.current).toBe('B');
  expect(renderHook(() => useTabProjectId('a2')).result.current).toBe('A');
  expect(renderHook(() => useTerminalProjectId('dispatch:B')).result.current).toBeUndefined();
});

test('useProjectIndicator rolls up one project and notifies only when the rollup changes', () => {
  const a = counted(() => useProjectIndicator('A'));
  const b = counted(() => useProjectIndicator('B'));
  expect(a.result.current).toBe('idle');
  status('a1', 'working');
  expect(a.result.current).toBe('working');
  expect(a.renders()).toBe(2);
  status('a2', 'working');                      // the rollup is still "working"
  expect(a.renders()).toBe(2);
  status('a2', 'needs_input');
  expect(a.result.current).toBe('needs_input');
  expect(b.result.current).toBe('idle');
  expect(b.renders()).toBe(1);
});

test('useProjectIndicator counts a starting thread as working, the session status, and the include filter', () => {
  act(() => { useTabs.setState({ loading: { b1: true } }); });
  expect(renderHook(() => useProjectIndicator('B')).result.current).toBe('working');
  expect(renderHook(() => useProjectIndicator('B', undefined, () => false)).result.current).toBe('idle');
  expect(renderHook(() => useProjectIndicator('A', 'error')).result.current).toBe('error');
});

test('lookupTerminal agrees with findTerminal, also after the map is replaced', () => {
  const before = useTabs.getState().byProject;
  expect(lookupTerminal(before, 'b1')).toBe(findTerminal(before, 'b1'));
  expect(lookupTerminal(before, 'nope')).toBeUndefined();
  expect(lookupTerminal(before, null)).toBeUndefined();
  status('b1', 'working');
  const after = useTabs.getState().byProject;
  expect(lookupTerminal(after, 'b1')).toBe(findTerminal(after, 'b1'));
  expect(lookupTerminal(after, 'b1')?.status).toBe('working');
  expect(lookupTerminal(before, 'b1')?.status).toBe('waiting');
});
