import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { UsageLimitsSection, UsageAlertSetting, clampWarn } from './UsageLimitsSection';
import { api } from '../../api/client';
import { useSettings } from '../../stores/settings';
import { useUsageLimits } from '../../stores/usageLimits';

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  useSettings.setState({ showUsageBanner: true });
  useUsageLimits.setState({ summary: null });
  vi.spyOn(api, 'getUsageLimitSettings').mockResolvedValue({ warnPercent: 80, pushOnWarn: true });
});

// The threshold lives in Usage limits and the push alert in Notifications; both halves read and write the
// same daemon setting with the same race rules, so they are rendered side by side here.
const renderBoth = () => render(<><UsageLimitsSection /><UsageAlertSetting /></>);
const level = () => screen.getByLabelText('Warning level percent') as HTMLInputElement;

describe('clampWarn', () => {
  it('rounds then clamps to 50..99', () => {
    expect(clampWarn(85.4)).toBe(85);
    expect(clampWarn(10)).toBe(50);
    expect(clampWarn(150)).toBe(99);
  });
});

describe('UsageLimitsSection + UsageAlertSetting', () => {
  it('loads the daemon values and says no figures yet', async () => {
    renderBoth();
    await waitFor(() => expect(level().value).toBe('80'));
    expect(screen.getByRole('switch', { name: 'Push alert at the warning level' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/No figures reported yet/)).toBeTruthy();
    for (const name of ['Warning', 'This device', 'Current figures']) expect(screen.getByRole('group', { name })).toBeTruthy();
  });

  it('the ring choice is a segmented control, and the phone header switch is this device only', async () => {
    useSettings.setState({ usageRingCenter: 'logo', phoneHeaderUsage: true });
    renderBoth();
    const device = within(screen.getByRole('group', { name: 'This device' }));
    expect(device.getByRole('radio', { name: 'Logo' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(device.getByRole('radio', { name: 'Percent used' }));
    expect(useSettings.getState().usageRingCenter).toBe('percent');
    fireEvent.click(device.getByRole('switch', { name: 'All accounts in the phone header' }));
    expect(useSettings.getState().phoneHeaderUsage).toBe(false);
  });

  it('shows each account as a card with a meter per window, its reset, and when the figures are from', async () => {
    const now = Date.now();
    useUsageLimits.setState({ summary: { warnPercent: 80, providers: [
      { provider: 'claude-code', accountId: 'cli', label: 'CLI login', plan: 'Max', asOf: now - 60_000, windows: { five_hour: { usedPercent: 42, resetsAt: now + 3_600_000 }, seven_day: { usedPercent: 71, resetsAt: now + 3 * 86_400_000 } } },
      { provider: 'claude-code', accountId: 'w1', label: 'Work', asOf: now - 60_000, windows: { five_hour: { usedPercent: 88, resetsAt: now + 3_600_000 } } },
      { provider: 'codex', accountId: 'cli', plan: 'Pro', asOf: now - 2 * 3_600_000, windows: { five_hour: { usedPercent: null, resetsAt: null } } },
    ], paused: [] } });
    renderBoth();
    const cards = screen.getAllByTestId('usage-account');
    expect(cards).toHaveLength(3);
    const cli = within(cards[0]);
    expect(cards[0]).toHaveTextContent('Claude · CLI login');
    expect(cards[0]).toHaveTextContent('Max');
    expect(cli.getByRole('meter', { name: 'Session (5h)' })).toHaveAttribute('aria-valuenow', '42');
    expect(cards[0]).toHaveTextContent('42%');
    expect(cards[0]).toHaveTextContent(/Resets/);
    expect(cli.getByRole('meter', { name: 'Weekly' })).toHaveAttribute('aria-valuenow', '71');
    // At or past the warning level: the meter says so in its tone.
    expect(within(cards[1]).getByRole('meter', { name: 'Session (5h)' })).toHaveAttribute('data-tone', 'red');
    // An old figure says how old; a window with no figure says so.
    expect(cards[2]).toHaveTextContent(/As of/);
    expect(cards[2]).toHaveTextContent('No figure reported');
    expect(screen.getByText(/CLI threads do not/)).toBeTruthy();
  });

  it('a pause shows above the cards', async () => {
    const now = Date.now();
    useUsageLimits.setState({ summary: { warnPercent: 80, providers: [], paused: [
      { provider: 'claude-code', kind: 'session', earliestResetsAt: now + 3_600_000, threads: 2, capped: 0, chat: false, firstTerminalId: 't', firstSessionId: null, episodeStartedAt: now },
    ] } });
    renderBoth();
    expect(screen.getByText(/Claude agents paused: session limit/)).toBeTruthy();
  });

  it('steps by 5 and clamps at the top', async () => {
    const put = vi.spyOn(api, 'setUsageLimitSettings').mockImplementation(async (p) => ({ warnPercent: p.warnPercent ?? 80, pushOnWarn: true }));
    renderBoth();
    await waitFor(() => expect(level().value).toBe('80'));
    fireEvent.click(screen.getByLabelText('Raise the warning level'));
    await waitFor(() => expect(level().value).toBe('85'));
    expect(put).toHaveBeenLastCalledWith({ warnPercent: 85 });
    for (const want of ['90', '95', '99']) { fireEvent.click(screen.getByLabelText('Raise the warning level')); await waitFor(() => expect(level().value).toBe(want)); }
    expect(put).toHaveBeenLastCalledWith({ warnPercent: 99 });
    expect(put).toHaveBeenCalledTimes(4);
    fireEvent.click(screen.getByLabelText('Raise the warning level')); // already at the top: no PUT
    expect(put).toHaveBeenCalledTimes(4);
  });

  it('a typed value is clamped on blur', async () => {
    const put = vi.spyOn(api, 'setUsageLimitSettings').mockImplementation(async (p) => ({ warnPercent: p.warnPercent ?? 80, pushOnWarn: true }));
    renderBoth();
    await waitFor(() => expect(level().value).toBe('80'));
    fireEvent.change(level(), { target: { value: '30' } });
    fireEvent.blur(level());
    await waitFor(() => expect(level().value).toBe('50'));
    expect(put).toHaveBeenCalledWith({ warnPercent: 50 });
  });

  it('a failed PUT rolls back and says so', async () => {
    vi.spyOn(api, 'setUsageLimitSettings').mockRejectedValue(new Error('500'));
    renderBoth();
    await waitFor(() => expect(level().value).toBe('80'));
    fireEvent.click(screen.getByLabelText('Lower the warning level'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not save'));
    expect(level().value).toBe('80');
    fireEvent.click(screen.getByRole('switch', { name: 'Push alert at the warning level' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Push alert at the warning level' }).getAttribute('aria-checked')).toBe('true'));
  });

  it('the banner switch is this device only', async () => {
    renderBoth();
    fireEvent.click(screen.getByRole('switch', { name: 'Show the paused banner on this device' }));
    expect(useSettings.getState().showUsageBanner).toBe(false);
    expect(localStorage.getItem('dispatch:usageBanner')).toBe('false');
  });

  it('follows the push switch another device changed', async () => {
    renderBoth();
    const sw = () => screen.getByRole('switch', { name: 'Push alert at the warning level' });
    await waitFor(() => expect(sw().getAttribute('aria-checked')).toBe('true'));
    act(() => { useUsageLimits.setState({ summary: { warnPercent: 80, pushOnWarn: false, providers: [], paused: [] } }); });
    await waitFor(() => expect(sw().getAttribute('aria-checked')).toBe('false'));
    act(() => { useUsageLimits.setState({ summary: { warnPercent: 80, pushOnWarn: true, providers: [], paused: [] } }); });
    await waitFor(() => expect(sw().getAttribute('aria-checked')).toBe('true'));
  });

  it('follows a threshold and a push switch that change together, and steps from the new threshold', async () => {
    const put = vi.spyOn(api, 'setUsageLimitSettings').mockImplementation(async (p) => ({ warnPercent: p.warnPercent ?? 90, pushOnWarn: false }));
    renderBoth();
    await waitFor(() => expect(level().value).toBe('80'));
    act(() => { useUsageLimits.setState({ summary: { warnPercent: 90, pushOnWarn: false, providers: [], paused: [] } }); });
    await waitFor(() => expect(level().value).toBe('90'));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Push alert at the warning level' }).getAttribute('aria-checked')).toBe('false'));
    fireEvent.click(screen.getByLabelText('Raise the warning level'));
    await waitFor(() => expect(put).toHaveBeenCalledWith({ warnPercent: 95 }));
  });

  it('follows a threshold another device set', async () => {
    renderBoth();
    await waitFor(() => expect(level().value).toBe('80'));
    act(() => { useUsageLimits.setState({ summary: { warnPercent: 90, providers: [], paused: [] } }); });
    await waitFor(() => expect(level().value).toBe('90'));
  });

  describe('races with another device', () => {
    const sw = () => screen.getByRole('switch', { name: 'Push alert at the warning level' });
    const deferred = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
    const broadcast = (warnPercent: number, pushOnWarn: boolean) => act(() => { useUsageLimits.setState({ summary: { warnPercent, pushOnWarn, providers: [], paused: [] } }); });

    it('a delayed GET does not overwrite a newer broadcast (90 and push off beat 80 and push on)', async () => {
      const get = deferred<{ warnPercent: number; pushOnWarn: boolean }>();
      vi.spyOn(api, 'getUsageLimitSettings').mockReturnValue(get.promise);
      renderBoth();
      broadcast(90, false);
      await waitFor(() => expect(level().value).toBe('90'));
      await waitFor(() => expect(sw().getAttribute('aria-checked')).toBe('false'));
      await act(async () => { get.resolve({ warnPercent: 80, pushOnWarn: true }); });
      expect(level().value).toBe('90');
      expect(sw().getAttribute('aria-checked')).toBe('false');
      // The next click steps from the newer value.
      const put = vi.spyOn(api, 'setUsageLimitSettings').mockImplementation(async (p) => ({ warnPercent: p.warnPercent ?? 90, pushOnWarn: false }));
      fireEvent.click(screen.getByLabelText('Raise the warning level'));
      await waitFor(() => expect(put).toHaveBeenCalledWith({ warnPercent: 95 }));
    });

    it('a broadcast already in the store when Settings opens beats a GET that answers later with older values', async () => {
      useUsageLimits.setState({ summary: { warnPercent: 90, pushOnWarn: false, providers: [], paused: [] } });
      const get = deferred<{ warnPercent: number; pushOnWarn: boolean }>();
      vi.spyOn(api, 'getUsageLimitSettings').mockReturnValue(get.promise);
      renderBoth();
      await act(async () => { get.resolve({ warnPercent: 80, pushOnWarn: true }); });
      expect(level().value).toBe('90');
      expect(sw().getAttribute('aria-checked')).toBe('false');
    });

    it('a PUT answered after a newer broadcast does not install its values', async () => {
      const put = deferred<{ warnPercent: number; pushOnWarn: boolean }>();
      vi.spyOn(api, 'setUsageLimitSettings').mockReturnValue(put.promise);
      renderBoth();
      await waitFor(() => expect(level().value).toBe('80'));
      fireEvent.click(screen.getByLabelText('Raise the warning level'));
      await waitFor(() => expect(level().value).toBe('85'));
      broadcast(95, false); // another device changed both while our PUT was in flight
      await waitFor(() => expect(level().value).toBe('95'));
      await act(async () => { put.resolve({ warnPercent: 85, pushOnWarn: true }); });
      expect(level().value).toBe('95');
      expect(sw().getAttribute('aria-checked')).toBe('false');
    });

    it('a failed PUT after a newer broadcast does not roll back over it', async () => {
      const put = deferred<{ warnPercent: number; pushOnWarn: boolean }>();
      vi.spyOn(api, 'setUsageLimitSettings').mockReturnValue(put.promise);
      renderBoth();
      await waitFor(() => expect(level().value).toBe('80'));
      fireEvent.click(screen.getByLabelText('Raise the warning level'));
      await waitFor(() => expect(level().value).toBe('85'));
      broadcast(95, false);
      await waitFor(() => expect(level().value).toBe('95'));
      await act(async () => { put.reject(new Error('500')); });
      expect(level().value).toBe('95');
      expect(sw().getAttribute('aria-checked')).toBe('false');
    });

    it('the first of two quick saves answering last does not undo the second', async () => {
      const first = deferred<{ warnPercent: number; pushOnWarn: boolean }>();
      const second = deferred<{ warnPercent: number; pushOnWarn: boolean }>();
      const put = vi.spyOn(api, 'setUsageLimitSettings').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      renderBoth();
      await waitFor(() => expect(level().value).toBe('80'));
      fireEvent.click(screen.getByLabelText('Raise the warning level'));
      await waitFor(() => expect(level().value).toBe('85'));
      fireEvent.click(screen.getByLabelText('Raise the warning level'));
      await waitFor(() => expect(level().value).toBe('90'));
      expect(put).toHaveBeenCalledTimes(2);
      await act(async () => { second.resolve({ warnPercent: 90, pushOnWarn: true }); });
      await act(async () => { first.resolve({ warnPercent: 85, pushOnWarn: true }); });
      expect(level().value).toBe('90');
    });
  });
});

describe('split between the two sections', () => {
  it('Usage limits no longer holds the push alert, and the alert names the level it fires at', async () => {
    const { unmount } = render(<UsageLimitsSection />);
    await waitFor(() => expect(level().value).toBe('80'));
    expect(screen.queryByRole('switch', { name: 'Push alert at the warning level' })).toBeNull();
    unmount();
    render(<UsageAlertSetting />);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Push alert at the warning level' })).toBeTruthy());
    expect(screen.getByText(/reaches 80%/)).toBeTruthy();
  });
});
