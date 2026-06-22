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
