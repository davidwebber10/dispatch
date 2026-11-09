import { expect, test, beforeEach } from 'vitest';
import { useThreadStatus } from './threadStatus';

beforeEach(() => useThreadStatus.setState({ byTerminal: {} }));

test('captures status + threadStatus + activity from a rich event', () => {
  useThreadStatus.getState().applyEvent({ type: 'terminal:status', terminalId: 't1', status: 'working', threadStatus: 'working', activity: 'Running: npm test' });
  expect(useThreadStatus.getState().byTerminal['t1']).toEqual({ status: 'working', threadStatus: 'working', activity: 'Running: npm test' });
});

test('clears activity when an event carries activity: null (idle)', () => {
  const s = useThreadStatus.getState();
  s.applyEvent({ type: 'terminal:status', terminalId: 't1', status: 'working', threadStatus: 'working', activity: 'Editing app.ts' });
  s.applyEvent({ type: 'terminal:status', terminalId: 't1', status: 'waiting', threadStatus: 'idle', activity: null });
  expect(useThreadStatus.getState().byTerminal['t1']).toEqual({ status: 'waiting', threadStatus: 'idle', activity: null });
});

test('keeps prior threadStatus/activity when a status-only event arrives (codex pty-timing)', () => {
  const s = useThreadStatus.getState();
  s.applyEvent({ type: 'terminal:status', terminalId: 't1', status: 'working', threadStatus: 'working', activity: 'Running: build' });
  s.applyEvent({ type: 'terminal:status', terminalId: 't1', status: 'working' }); // no threadStatus/activity keys
  expect(useThreadStatus.getState().byTerminal['t1']).toEqual({ status: 'working', threadStatus: 'working', activity: 'Running: build' });
});

test('terminal:exit resets to idle and clears activity', () => {
  const s = useThreadStatus.getState();
  s.applyEvent({ type: 'terminal:status', terminalId: 't1', status: 'working', threadStatus: 'working', activity: 'x' });
  s.applyEvent({ type: 'terminal:exit', terminalId: 't1' });
  expect(useThreadStatus.getState().byTerminal['t1']).toMatchObject({ status: 'waiting', threadStatus: 'idle', activity: null });
});

// W1-D: the stall flags of the daemon's watchdog.
import { vi } from 'vitest';
import { api } from '../api/client';

test('a terminal:stall event sets and clears the entry', () => {
  useThreadStatus.setState({ stalls: {} });
  const s = useThreadStatus.getState();
  s.applyEvent({ type: 'terminal:stall', terminalId: 't1', stalledSince: '2026-11-09T10:00:00.000Z' });
  expect(useThreadStatus.getState().stalls).toEqual({ t1: Date.parse('2026-11-09T10:00:00.000Z') });
  s.applyEvent({ type: 'terminal:stall', terminalId: 't2', stalledSince: '2026-11-09T10:05:00.000Z' });
  s.applyEvent({ type: 'terminal:stall', terminalId: 't1', stalledSince: null });
  expect(useThreadStatus.getState().stalls).toEqual({ t2: Date.parse('2026-11-09T10:05:00.000Z') });
});

test('a terminal:stall event with a bad time is ignored', () => {
  useThreadStatus.setState({ stalls: {} });
  useThreadStatus.getState().applyEvent({ type: 'terminal:stall', terminalId: 't1', stalledSince: 'not a date' });
  useThreadStatus.getState().applyEvent({ type: 'terminal:stall', stalledSince: '2026-11-09T10:00:00.000Z' });
  expect(useThreadStatus.getState().stalls).toEqual({});
});

test('a status that is not working, or an exit, clears the stall of that thread at once', () => {
  useThreadStatus.setState({ stalls: { t1: 1, t2: 2, t3: 3 } });
  const s = useThreadStatus.getState();
  s.applyEvent({ type: 'terminal:status', terminalId: 't1', status: 'waiting', threadStatus: 'idle', activity: null });
  s.applyEvent({ type: 'terminal:exit', terminalId: 't2' });
  s.applyEvent({ type: 'terminal:status', terminalId: 't3', status: 'working', threadStatus: 'working', activity: 'Thinking' });
  expect(useThreadStatus.getState().stalls).toEqual({ t3: 3 });
});

test('reset keeps the stall flags: only loadStalls replaces them', () => {
  useThreadStatus.setState({ byTerminal: { t1: { status: 'working' } }, stalls: { t1: 5 } });
  useThreadStatus.getState().reset();
  expect(useThreadStatus.getState().byTerminal).toEqual({});
  expect(useThreadStatus.getState().stalls).toEqual({ t1: 5 });
});

test('loadStalls replaces the entries with the daemon list; a failed read keeps them', async () => {
  useThreadStatus.setState({ stalls: { old: 1 } });
  const listStalls = vi.spyOn(api, 'listStalls').mockResolvedValueOnce([{ terminalId: 't9', stalledSince: 42, lastFrameAt: null }]);
  await useThreadStatus.getState().loadStalls();
  expect(useThreadStatus.getState().stalls).toEqual({ t9: 42 });
  listStalls.mockRejectedValueOnce(new Error('offline'));
  await useThreadStatus.getState().loadStalls();
  expect(useThreadStatus.getState().stalls).toEqual({ t9: 42 });
  listStalls.mockRestore();
});
