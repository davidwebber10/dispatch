import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { UsageLimitsSection, clampWarn } from './UsageLimitsSection';
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

const level = () => screen.getByLabelText('Warning level percent') as HTMLInputElement;

describe('clampWarn', () => {
  it('rounds then clamps to 50..99', () => {
    expect(clampWarn(85.4)).toBe(85);
    expect(clampWarn(10)).toBe(50);
    expect(clampWarn(150)).toBe(99);
  });
});

describe('UsageLimitsSection', () => {
  it('loads the daemon values and says no figures yet', async () => {
    render(<UsageLimitsSection />);
    await waitFor(() => expect(level().value).toBe('80'));
    expect(screen.getByRole('switch', { name: 'Push alert at the warning level' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('No figures reported yet')).toBeTruthy();
    expect(screen.getByText('ALL DEVICES')).toBeTruthy();
    expect(screen.getByText('THIS DEVICE')).toBeTruthy();
  });

  it('steps by 5 and clamps at the top', async () => {
    const put = vi.spyOn(api, 'setUsageLimitSettings').mockImplementation(async (p) => ({ warnPercent: p.warnPercent ?? 80, pushOnWarn: true }));
    render(<UsageLimitsSection />);
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
    render(<UsageLimitsSection />);
    await waitFor(() => expect(level().value).toBe('80'));
    fireEvent.change(level(), { target: { value: '30' } });
    fireEvent.blur(level());
    await waitFor(() => expect(level().value).toBe('50'));
    expect(put).toHaveBeenCalledWith({ warnPercent: 50 });
  });

  it('a failed PUT rolls back and says so', async () => {
    vi.spyOn(api, 'setUsageLimitSettings').mockRejectedValue(new Error('500'));
    render(<UsageLimitsSection />);
    await waitFor(() => expect(level().value).toBe('80'));
    fireEvent.click(screen.getByLabelText('Lower the warning level'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not save'));
    expect(level().value).toBe('80');
    fireEvent.click(screen.getByRole('switch', { name: 'Push alert at the warning level' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Push alert at the warning level' }).getAttribute('aria-checked')).toBe('true'));
  });

  it('the banner switch is this device only', async () => {
    render(<UsageLimitsSection />);
    fireEvent.click(screen.getByRole('switch', { name: 'Show the paused banner on this device' }));
    expect(useSettings.getState().showUsageBanner).toBe(false);
    expect(localStorage.getItem('dispatch:usageBanner')).toBe('false');
  });

  it('follows a threshold another device set', async () => {
    render(<UsageLimitsSection />);
    await waitFor(() => expect(level().value).toBe('80'));
    act(() => { useUsageLimits.setState({ summary: { warnPercent: 90, providers: [], paused: [] } }); });
    await waitFor(() => expect(level().value).toBe('90'));
  });
});
