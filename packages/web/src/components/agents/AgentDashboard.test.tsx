import { render, screen, fireEvent } from '@testing-library/react';
import { test, expect, beforeEach, vi } from 'vitest';
import { AgentDashboard } from './AgentDashboard';
import { useAgents } from '../../stores/agents';

beforeEach(() => useAgents.setState({ schedules: [], runs: [], selectedId: null }));

test('shows the selected agent and KPIs derived from its runs', () => {
  useAgents.setState({
    schedules: [{ id: 'a1', name: 'Triage flaky tests', provider: 'claude-code', enabled: true, scheduleKind: 'recurring', recurrenceRule: JSON.stringify({ type: 'daily', time: '09:00' }), prompt: 'find flaky tests', nextRunAt: null } as any],
    selectedId: 'a1',
    runs: [
      { id: 'r1', scheduleId: 'a1', status: 'succeeded', startedAt: '2026-06-18T00:00:00Z', completedAt: '2026-06-18T00:00:30Z', costUsd: 0.40, totalTokens: 41205 } as any,
      { id: 'r2', scheduleId: 'a1', status: 'failed', startedAt: '2026-06-18T00:00:00Z', completedAt: '2026-06-18T00:01:00Z', costUsd: 0.60, totalTokens: 60000 } as any,
    ],
  });
  render(<AgentDashboard onEdit={() => {}} onOpenRun={() => {}} />);
  expect(screen.getByText('Triage flaky tests')).toBeInTheDocument();
  expect(screen.getByText('TOTAL RUNS')).toBeInTheDocument();
  expect(screen.getByText('2')).toBeInTheDocument();   // total runs
  expect(screen.getByText('50%')).toBeInTheDocument();  // success rate (1 of 2 finished)
  expect(screen.getByText('AVG COST')).toBeInTheDocument();
  expect(screen.getByText('$0.50')).toBeInTheDocument(); // avg cost (0.40 + 0.60) / 2
});

const sched = (over: Record<string, unknown>) => ({ id: 'a1', name: 'Nightly', provider: 'claude-code', enabled: true, scheduleKind: 'recurring', recurrenceRule: JSON.stringify({ type: 'daily', time: '09:00' }), prompt: 'p', nextRunAt: null, ...over } as any);

test('shows who created the schedule', () => {
  useAgents.setState({ schedules: [sched({ createdBy: { kind: 'thread', terminalId: 'abcdef123456', name: 'Fix login' } })], selectedId: 'a1', runs: [] });
  render(<AgentDashboard onEdit={() => {}} onOpenRun={() => {}} />);
  expect(screen.getByTestId('schedule-creator')).toHaveTextContent('Thread: Fix login');
});

test('shows a schedule with no creator record as Unknown', () => {
  useAgents.setState({ schedules: [sched({})], selectedId: 'a1', runs: [] });
  render(<AgentDashboard onEdit={() => {}} onOpenRun={() => {}} />);
  expect(screen.getByTestId('schedule-creator')).toHaveTextContent('Unknown');
});

test('shows a Close button only when the pane can be closed', () => {
  useAgents.setState({ schedules: [sched({})], selectedId: 'a1', runs: [] });
  const { rerender } = render(<AgentDashboard onEdit={() => {}} onOpenRun={() => {}} />);
  expect(screen.queryByRole('button', { name: 'Close automation' })).toBeNull();
  const onClose = vi.fn();
  rerender(<AgentDashboard onEdit={() => {}} onOpenRun={() => {}} onClose={onClose} />);
  fireEvent.click(screen.getByRole('button', { name: 'Close automation' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});
