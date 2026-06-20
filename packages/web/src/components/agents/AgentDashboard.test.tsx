import { render, screen } from '@testing-library/react';
import { test, expect, beforeEach } from 'vitest';
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
