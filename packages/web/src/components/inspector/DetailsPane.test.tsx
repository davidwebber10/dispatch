import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { vi, beforeEach, afterEach, it, expect } from 'vitest';
import { DetailsPane } from './DetailsPane';
import { api } from '../../api/client';
import { useProjects } from '../../stores/projects';
import type { ThreadUsageLimits } from '../../api/types';

const FUTURE = Date.now() + 3 * 3600_000;
const claude: ThreadUsageLimits = {
  provider: 'claude-code', supported: true, paused: null,
  snapshot: { asOf: Date.now() - 60_000, windows: { five_hour: { usedPercent: 62, resetsAt: FUTURE }, seven_day: { usedPercent: 24, resetsAt: Date.now() + 3 * 24 * 3600_000 } } },
};

beforeEach(() => {
  useProjects.setState({ sessions: [{ id: 'p1', name: 'Proj', workingDir: '/tmp/x', provider: 'claude-code', status: 'waiting' } as any] });
  vi.spyOn(api, 'getTerminal').mockResolvedValue({ id: 't1', workingDir: '/tmp/x', pid: 1, status: 'idle' } as any);
  vi.spyOn(api, 'getGitInfo').mockResolvedValue({ branch: 'main' } as any);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('shows session, weekly, and the as-of line under THREAD DETAILS', async () => {
  vi.spyOn(api, 'getUsageLimits').mockResolvedValue(claude);
  render(<DetailsPane projectId="p1" terminalId="t1" />);
  expect(await screen.findByText('Session (5h)')).toBeTruthy();
  expect(screen.getByText(/^62% used, resets /)).toBeTruthy();
  expect(screen.getByText('Weekly')).toBeTruthy();
  expect(screen.getByText(/^24% used, resets /)).toBeTruthy();
  expect(screen.getByText(/^As of /)).toBeTruthy();
  expect(screen.queryByText('Fable')).toBeNull();
  expect(screen.queryByText('Opus')).toBeNull();
  expect(screen.getByText('THREAD DETAILS')).toBeTruthy();
});

it('shows the Fable row only when reported, and the pause line', async () => {
  vi.spyOn(api, 'getUsageLimits').mockResolvedValue({ ...claude, paused: { kind: 'session', resetsAt: FUTURE, capped: false }, snapshot: { ...claude.snapshot!, windows: { ...claude.snapshot!.windows, seven_day_overage_included: { usedPercent: 5, resetsAt: FUTURE } } } });
  render(<DetailsPane projectId="p1" terminalId="t1" />);
  expect(await screen.findByText('Fable')).toBeTruthy();
  expect(screen.getByText(/^Paused: session limit, resumes /)).toBeTruthy();
});

it('a grok or opencode thread says Not reported', async () => {
  vi.spyOn(api, 'getUsageLimits').mockResolvedValue({ provider: 'grok', supported: false, snapshot: null, paused: null });
  render(<DetailsPane projectId="p1" terminalId="t1" />);
  await waitFor(() => expect(screen.getByText('Not reported')).toBeTruthy());
});

it('a failed fetch shows no limits section and nothing breaks', async () => {
  vi.spyOn(api, 'getUsageLimits').mockRejectedValue(new Error('down'));
  render(<DetailsPane projectId="p1" terminalId="t1" />);
  await screen.findByText('THREAD');
  expect(screen.queryByTestId('usage-limits')).toBeNull();
});

it('switching threads drops the old thread\'s figures and pause, even if the new fetch fails', async () => {
  const spy = vi.spyOn(api, 'getUsageLimits').mockResolvedValue({ ...claude, paused: { kind: 'session', resetsAt: FUTURE, capped: false } });
  const { rerender } = render(<DetailsPane projectId="p1" terminalId="t1" />);
  expect(await screen.findByText(/^Paused: session limit/)).toBeTruthy();
  spy.mockRejectedValue(new Error('404'));
  rerender(<DetailsPane projectId="p1" terminalId="t2" />);
  await waitFor(() => expect(screen.queryByText('Session (5h)')).toBeNull());
  expect(screen.queryByText(/^Paused:/)).toBeNull();
});

it('a refresh from new turn numbers keeps the rows on screen while it loads (no flicker)', async () => {
  vi.spyOn(api, 'getUsageLimits').mockResolvedValueOnce(claude).mockImplementation(() => new Promise(() => {}));
  const { useActivity } = await import('../../stores/activity');
  const { act } = await import('@testing-library/react');
  render(<DetailsPane projectId="p1" terminalId="t1" />);
  expect(await screen.findByText('Session (5h)')).toBeTruthy();
  act(() => { useActivity.setState({ byTerminal: { t1: { tokens: '12k', cost: '$1' } as any } }); });
  expect(screen.getByText('Session (5h)')).toBeTruthy();
});
