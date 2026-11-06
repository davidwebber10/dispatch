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
    expect(screen.getByText('THIS DEVICE')).toBeInTheDocument();
    expect(screen.getByText('ALL DEVICES')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Push notifications on this device' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Push alert at the warning level' })).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByText(/reaches 85%/)).toBeInTheDocument();
    expect(screen.getByText('NOTIFICATION DEVICES')).toBeInTheDocument();
  });

  it('those settings left their old homes', async () => {
    vi.spyOn(api, 'getAccessAddresses').mockResolvedValue({ tailscale: [], lan: [] });
    vi.spyOn(api, 'getDevices').mockResolvedValue({ devices: [], currentDeviceId: null, legacyOpen: false } as never);
    const { unmount } = render(<AccessSection />);
    expect(screen.queryByText('NOTIFICATION DEVICES')).toBeNull();
    unmount();
    render(<UsageLimitsSection />);
    await waitFor(() => expect(screen.getByLabelText('Warning level percent')).toBeInTheDocument());
    expect(screen.queryByRole('switch', { name: 'Push alert at the warning level' })).toBeNull();
  });
});
