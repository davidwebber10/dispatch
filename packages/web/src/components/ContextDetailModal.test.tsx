import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { vi, afterEach, it, expect } from 'vitest';
import { ContextDetailModal } from './ContextDetailModal';
import { api } from '../api/client';
import type { ThreadUsageLimits } from '../api/types';

const FUTURE = Date.now() + 3 * 3600_000;
const base = { compacting: false, compactResult: null, compact: () => {}, onClose: () => {}, contextTokens: 1000, model: 'claude-opus-4-6' };
const claude = (windows: NonNullable<ThreadUsageLimits['snapshot']>['windows'], paused: ThreadUsageLimits['paused'] = null): ThreadUsageLimits =>
  ({ provider: 'claude-code', supported: true, paused, snapshot: { asOf: Date.now() - 60_000, windows } });

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('shows the same limit rows as the Details pane, with the as-of line and the pause', async () => {
  vi.spyOn(api, 'getUsageLimits').mockResolvedValue(claude(
    { five_hour: { usedPercent: 62, resetsAt: FUTURE }, seven_day: { usedPercent: 24, resetsAt: FUTURE }, seven_day_overage_included: { usedPercent: 5, resetsAt: FUTURE }, seven_day_future: { usedPercent: 1, resetsAt: FUTURE } },
    { kind: 'session', resetsAt: FUTURE, capped: false },
  ));
  render(<ContextDetailModal {...base} terminalId="t1" />);
  expect(await screen.findByText('Session (5h)')).toBeTruthy();
  expect(screen.getByText('Weekly')).toBeTruthy();
  expect(screen.getByText('Fable')).toBeTruthy();
  expect(screen.getByText('seven_day_future')).toBeTruthy(); // unknown type: raw name
  expect(screen.queryByText('Opus')).toBeNull();               // never a fixed row
  expect(screen.getByText(/^62% used, resets /)).toBeTruthy();
  expect(screen.getByText(/^As of /)).toBeTruthy();
  expect(screen.getByText(/^Paused: session limit, resumes /)).toBeTruthy();
  expect(screen.getAllByText('Context window').length).toBeGreaterThan(0);
});

it('says Not reported for a provider with no limits, and Not reported yet with no figure', async () => {
  const spy = vi.spyOn(api, 'getUsageLimits').mockResolvedValue({ provider: 'grok', supported: false, snapshot: null, paused: null });
  const { unmount } = render(<ContextDetailModal {...base} terminalId="t1" />);
  expect(await screen.findByText('Not reported')).toBeTruthy();
  unmount();
  spy.mockResolvedValue({ provider: 'claude-code', supported: true, snapshot: null, paused: null });
  render(<ContextDetailModal {...base} terminalId="t1" />);
  expect(await screen.findByText('Not reported yet')).toBeTruthy();
});

it('old-account numbers are not kept: a later answer with no snapshot for the new account shows none', async () => {
  const spy = vi.spyOn(api, 'getUsageLimits').mockResolvedValueOnce(claude({ five_hour: { usedPercent: 99, resetsAt: FUTURE } }));
  const { unmount } = render(<ContextDetailModal {...base} terminalId="t1" />);
  expect(await screen.findByText(/^99% used/)).toBeTruthy();
  unmount();
  spy.mockResolvedValue({ provider: 'claude-code', supported: true, snapshot: null, paused: null }); // the server drops another account's snapshot
  render(<ContextDetailModal {...base} terminalId="t1" />);
  await waitFor(() => expect(screen.getByText('Not reported yet')).toBeTruthy());
  expect(screen.queryByText(/99% used/)).toBeNull();
});

it('without a terminalId there is no Usage limits section and nothing is fetched', () => {
  const spy = vi.spyOn(api, 'getUsageLimits');
  render(<ContextDetailModal {...base} />);
  expect(screen.queryByText('USAGE LIMITS')).toBeNull();
  expect(spy).not.toHaveBeenCalled();
});

it('a failed fetch leaves the context popup as it was', async () => {
  vi.spyOn(api, 'getUsageLimits').mockRejectedValue(new Error('down'));
  render(<ContextDetailModal {...base} terminalId="t1" />);
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByText('USAGE LIMITS')).toBeNull();
  expect(screen.getByText('Tokens used')).toBeTruthy();
});
