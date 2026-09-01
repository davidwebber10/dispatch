import { expect, test, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, cleanup } from '@testing-library/react';
import { CliStatusCard } from './CliStatusCard';
import { useThreadStatus } from '../../stores/threadStatus';
import { api } from '../../api/client';
import type { Terminal } from '../../api/types';

vi.mock('../../api/client', () => ({
  api: { getTerminal: vi.fn() },
}));

function tab(lastOutcome: Record<string, unknown> | undefined): Terminal {
  return {
    id: 't1', sessionId: 's1', type: 'claude-code', label: 'thread', pid: 1, externalId: 'e1',
    workingDir: null, status: 'idle', createdAt: '', config: lastOutcome ? { lastOutcome } : {},
    archivedAt: null, sortOrder: 0,
  } as unknown as Terminal;
}

beforeEach(() => {
  useThreadStatus.setState({ byTerminal: {} } as any);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); (api.getTerminal as any).mockReset(); });

test('a declared blocked outcome renders the BLOCKED card with summary and blocker', () => {
  render(<CliStatusCard tab={tab({ summary: 'Attempt 4 failed with the same Apple 403.', needsHelp: false, inferred: false, declaredState: 'blocked', blocker: 'Apple agreement flag not cleared.', at: 'x' })} />);
  expect(screen.getByText('BLOCKED')).toBeInTheDocument();
  expect(screen.getByText('Attempt 4 failed with the same Apple 403.')).toBeInTheDocument();
  expect(screen.getByText('Apple agreement flag not cleared.')).toBeInTheDocument();
});

test('a declared done outcome renders the DONE card with the summary', () => {
  render(<CliStatusCard tab={tab({ summary: 'Release verified in prod.', needsHelp: false, inferred: false, declaredState: 'done', at: 'x' })} />);
  expect(screen.getByText('DONE')).toBeInTheDocument();
  expect(screen.getByText('Release verified in prod.')).toBeInTheDocument();
});

test('a needs-help outcome renders NEEDS YOU with the summary, but never the ask (the banner owns it)', () => {
  render(<CliStatusCard tab={tab({ summary: 'Found three candidate causes; details inside.', needsHelp: true, inferred: false, at: 'x' })} />);
  expect(screen.getByText('NEEDS YOU')).toBeInTheDocument();
  expect(screen.getByText('Found three candidate causes; details inside.')).toBeInTheDocument();
});

test('an inferred outcome renders nothing — undeclared summaries are just transcript text', () => {
  render(<CliStatusCard tab={tab({ summary: 'some closing sentence', needsHelp: false, inferred: true, at: 'x' })} />);
  expect(screen.queryByTestId('status-notice')).toBeNull();
});

test('a declared-nothing outcome (no state, no needsHelp) renders nothing', () => {
  render(<CliStatusCard tab={tab({ summary: 'plain end of turn', needsHelp: false, inferred: false, at: 'x' })} />);
  expect(screen.queryByTestId('status-notice')).toBeNull();
});

test('no outcome at all renders nothing', () => {
  render(<CliStatusCard tab={tab(undefined)} />);
  expect(screen.queryByTestId('status-notice')).toBeNull();
});

test('the card hides while a new turn is running', () => {
  useThreadStatus.setState({ byTerminal: { t1: { threadStatus: 'working' } } } as any);
  render(<CliStatusCard tab={tab({ summary: 'stale outcome', needsHelp: false, inferred: false, declaredState: 'done', at: 'x' })} />);
  expect(screen.queryByTestId('status-notice')).toBeNull();
});

test('when the turn settles, the card refetches the terminal and shows the NEW outcome', async () => {
  (api.getTerminal as any).mockResolvedValue(tab({ summary: 'Fresh result from this turn.', needsHelp: false, inferred: false, declaredState: 'done', at: 'y' }));
  useThreadStatus.setState({ byTerminal: { t1: { threadStatus: 'working' } } } as any);
  render(<CliStatusCard tab={tab({ summary: 'old outcome', needsHelp: false, inferred: false, declaredState: 'blocked', blocker: 'old blocker', at: 'x' })} />);
  expect(screen.queryByTestId('status-notice')).toBeNull(); // hidden mid-turn
  act(() => { useThreadStatus.setState({ byTerminal: { t1: { threadStatus: 'idle' } } } as any); });
  await waitFor(() => expect(api.getTerminal).toHaveBeenCalledWith('t1'));
  expect(await screen.findByText('Fresh result from this turn.')).toBeInTheDocument();
  expect(screen.queryByText('old outcome')).toBeNull();
});
