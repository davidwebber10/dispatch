import { render, screen, fireEvent } from '@testing-library/react';
import { test, expect, beforeEach, vi } from 'vitest';
import { AgentPane } from './AgentPane';
import { useAgents } from '../../stores/agents';
import { useAgentUI } from '../../stores/agentUI';

vi.mock('./RunnerView', () => ({ RunnerView: ({ onBack }: { onBack: () => void }) => <button onClick={onBack}>runner back</button> }));

const sched = { id: 'a1', name: 'Nightly', provider: 'claude-code', enabled: true, scheduleKind: 'recurring', recurrenceRule: JSON.stringify({ type: 'daily', time: '09:00' }), prompt: 'p', nextRunAt: null } as any;
const run = { id: 'r1', scheduleId: 'a1', status: 'succeeded', startedAt: '2026-06-18T00:00:00Z', completedAt: '2026-06-18T00:00:30Z', costUsd: 0.4, totalTokens: 10 } as any;

beforeEach(() => {
  useAgents.setState({ schedules: [sched], runs: [run], selectedId: 'a1' });
  useAgentUI.setState({ focused: true, editing: null });
});

test('the Close button calls onClose', () => {
  const onClose = vi.fn();
  render(<AgentPane onClose={onClose} />);
  fireEvent.click(screen.getByRole('button', { name: 'Close automation' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('Escape closes the pane', () => {
  const onClose = vi.fn();
  render(<AgentPane onClose={onClose} />);
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('Escape does nothing without onClose (phone layout has its own back)', () => {
  render(<AgentPane />);
  expect(screen.queryByRole('button', { name: 'Close automation' })).toBeNull();
  fireEvent.keyDown(window, { key: 'Escape' }); // must not throw
});

test('Escape in a text field, with the edit modal open, or already handled does not close', () => {
  const onClose = vi.fn();
  const { container } = render(<><input data-testid="f" /><AgentPane onClose={onClose} /></>);
  fireEvent.keyDown(screen.getByTestId('f'), { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
  useAgentUI.setState({ editing: { scheduleId: 'a1', preset: null } });
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
  useAgentUI.setState({ editing: null });
  const ev = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
  ev.preventDefault();
  window.dispatchEvent(ev);
  expect(onClose).not.toHaveBeenCalled();
  expect(container).toBeTruthy();
});

test('Escape inside a run goes back to the dashboard first, then closes', () => {
  const onClose = vi.fn();
  render(<AgentPane onClose={onClose} />);
  fireEvent.click(screen.getByText('succeeded'));
  expect(screen.getByText('runner back')).toBeInTheDocument();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.queryByText('runner back')).toBeNull();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
});
