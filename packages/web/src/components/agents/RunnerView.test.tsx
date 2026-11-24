import { render, screen, fireEvent } from '@testing-library/react';
import { test, expect, beforeEach, vi } from 'vitest';
import { RunnerView } from './RunnerView';
import { useAgents } from '../../stores/agents';

vi.mock('../tabs/LazyTerminalTab', () => ({ TerminalTab: ({ terminalId }: { terminalId: string }) => <div data-testid="raw-terminal">{terminalId}</div> }));
vi.mock('../../api/client', () => ({ api: { markRunOpened: vi.fn(), cancelRun: vi.fn() } }));

const sched = { id: 'a1', name: 'Nightly', provider: 'claude-code' } as any;
const base = { id: 'r1', scheduleId: 'a1', terminalId: 't1', startedAt: '2026-06-18T00:00:00Z', completedAt: '2026-06-18T00:00:30Z', costUsd: 0.4, totalTokens: 10 };

function open(status: string) {
  useAgents.setState({ schedules: [sched], runs: [{ ...base, status } as any], runSteps: { r1: [] }, loadRunSteps: vi.fn() } as any);
  const view = render(<RunnerView runId="r1" onBack={() => {}} />);
  fireEvent.click(screen.getByTitle('Toggle raw output'));
  return view;
}

beforeEach(() => { useAgents.setState({ runs: [], schedules: [], runSteps: {} } as any); });

test('the Raw tab of a finished run does not attach to its terminal (an attach could start the run again)', () => {
  for (const status of ['succeeded', 'failed', 'cancelled']) {
    const { unmount } = open(status);
    expect(screen.queryByTestId('raw-terminal')).toBeNull();
    expect(screen.getByText(/finished/i)).toBeInTheDocument();
    unmount();
  }
});

test('the Raw tab of a live run still shows its terminal', () => {
  open('working');
  expect(screen.getByTestId('raw-terminal')).toHaveTextContent('t1');
});
