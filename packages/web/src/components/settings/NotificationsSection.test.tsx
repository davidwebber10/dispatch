import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { NotificationsSection } from './NotificationsSection';
import { AccessSection } from './AccessSection';
import { UsageLimitsSection } from './UsageLimitsSection';
import { api } from '../../api/client';
import { useUsageLimits } from '../../stores/usageLimits';

beforeEach(() => {
  vi.restoreAllMocks();
  useUsageLimits.setState({ summary: null });
  vi.spyOn(api, 'getUsageLimitSettings').mockResolvedValue({ warnPercent: 85, pushOnWarn: true });
  vi.spyOn(api, 'getPushSubscriptions').mockResolvedValue({ subscriptions: [] });
});

describe('NotificationsSection', () => {
  it('gathers the three notification settings, labelled by scope', async () => {
    render(<NotificationsSection />);
    expect(screen.getByRole('group', { name: 'This device' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Usage alerts' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Push notifications on this device' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Push alert at the warning level' })).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByText(/reaches 85%/)).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Devices that get alerts' })).toBeInTheDocument();
  });

  it('uses grouped cards: switches sit in settings rows', async () => {
    render(<NotificationsSection />);
    const push = screen.getByRole('switch', { name: 'Push notifications on this device' });
    expect(push.closest('[data-testid="settings-row"]')).not.toBeNull();
    const warn = await screen.findByRole('switch', { name: 'Push alert at the warning level' });
    expect(warn.closest('[data-testid="settings-row"]')).not.toBeNull();
  });

  it('those settings left their old homes', async () => {
    vi.spyOn(api, 'getAccessAddresses').mockResolvedValue({ tailscale: [], lan: [] });
    vi.spyOn(api, 'getDevices').mockResolvedValue({ devices: [], currentDeviceId: null, legacyOpen: false } as never);
    const { unmount } = render(<AccessSection />);
    expect(screen.queryByRole('group', { name: 'Devices that get alerts' })).toBeNull();
    unmount();
    render(<UsageLimitsSection />);
    await waitFor(() => expect(screen.getByLabelText('Warning level percent')).toBeInTheDocument());
    expect(screen.queryByRole('switch', { name: 'Push alert at the warning level' })).toBeNull();
  });
});
