import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PushSubscriptionsList } from './PushSubscriptionsList';
import { api, type PushSubscriptionInfo } from '../../api/client';
import { useSettings } from '../../stores/settings';

vi.mock('../../api/client', async (orig) => {
  const real = await orig<typeof import('../../api/client')>();
  return { ...real, api: { ...real.api, getPushSubscriptions: vi.fn(), revokePushSubscription: vi.fn(), pushUnsubscribe: vi.fn().mockResolvedValue({ ok: true }) } };
});

const NOW = Date.parse('2026-11-04T12:00:00Z');
const sub = (over: Partial<PushSubscriptionInfo> = {}): PushSubscriptionInfo => ({
  deviceId: 'other', label: 'iPhone · Safari', host: 'web.push.apple.com',
  createdAt: '2026-11-01T12:00:00Z', lastSentAt: '2026-11-04T11:30:00Z', ...over,
});

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api.getPushSubscriptions).mockReset();
  vi.mocked(api.revokePushSubscription).mockReset();
});

describe('<PushSubscriptionsList>', () => {
  it('shows label, push service host, added date and last alert, and marks this device', async () => {
    localStorage.setItem('dispatch:deviceId', 'me');
    vi.mocked(api.getPushSubscriptions).mockResolvedValue({ subscriptions: [sub({ deviceId: 'me', label: 'Mac · Chrome', host: 'fcm.googleapis.com', lastSentAt: null }), sub()] });
    render(<PushSubscriptionsList now={() => NOW} />);
    const rows = await screen.findAllByTestId('push-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('Mac · Chrome')).toBeTruthy();
    expect(within(rows[0]).getByText('This device')).toBeTruthy();
    expect(within(rows[0]).getByText(/fcm\.googleapis\.com/)).toBeTruthy();
    expect(within(rows[0]).getByText(/No alert yet/)).toBeTruthy();
    expect(within(rows[1]).getByText(/web\.push\.apple\.com/)).toBeTruthy();
    expect(within(rows[1]).getByText(/Last alert 30m ago/)).toBeTruthy();
    expect(within(rows[1]).queryByText('This device')).toBeNull();
    // One line under the name: no three-line box, the added date moves to the row's tooltip.
    expect(rows[1].getAttribute('title')).toMatch(/^Added /);
    expect(screen.getByRole('group', { name: 'Devices that get alerts' })).toBeTruthy();
  });

  it('says so when no device receives notifications', async () => {
    vi.mocked(api.getPushSubscriptions).mockResolvedValue({ subscriptions: [] });
    render(<PushSubscriptionsList now={() => NOW} />);
    expect(await screen.findByText(/No device gets alerts yet/)).toBeTruthy();
  });

  it('asks to confirm, then revokes one device and reloads', async () => {
    vi.mocked(api.getPushSubscriptions)
      .mockResolvedValueOnce({ subscriptions: [sub()] })
      .mockResolvedValueOnce({ subscriptions: [] });
    vi.mocked(api.revokePushSubscription).mockResolvedValue({ ok: true });
    render(<PushSubscriptionsList now={() => NOW} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke iPhone · Safari' }));
    expect(api.revokePushSubscription).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog', { name: 'Stop alerts to iPhone · Safari?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(api.revokePushSubscription).toHaveBeenCalledWith('other'));
    expect(await screen.findByText(/No device gets alerts yet/)).toBeTruthy();
  });

  it('cancel does not revoke', async () => {
    vi.mocked(api.getPushSubscriptions).mockResolvedValue({ subscriptions: [sub()] });
    render(<PushSubscriptionsList now={() => NOW} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke iPhone · Safari' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.revokePushSubscription).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Revoke iPhone · Safari' })).toBeTruthy();
  });

  it('turns this browser\'s notification switch off when its own subscription is revoked', async () => {
    localStorage.setItem('dispatch:deviceId', 'me');
    const setPushEnabled = vi.fn().mockResolvedValue(undefined);
    useSettings.setState({ setPushEnabled } as any);
    vi.mocked(api.getPushSubscriptions).mockResolvedValue({ subscriptions: [sub({ deviceId: 'me' })] });
    vi.mocked(api.revokePushSubscription).mockResolvedValue({ ok: true });
    render(<PushSubscriptionsList now={() => NOW} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Revoke / }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(setPushEnabled).toHaveBeenCalledWith(false));
  });

  it('shows an error and keeps the row when a revoke fails', async () => {
    vi.mocked(api.getPushSubscriptions).mockResolvedValue({ subscriptions: [sub()] });
    vi.mocked(api.revokePushSubscription).mockRejectedValue(new Error('boom'));
    render(<PushSubscriptionsList now={() => NOW} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Revoke / }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Revoke' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not revoke iPhone · Safari/);
    expect(screen.getAllByTestId('push-row')).toHaveLength(1);
  });

  it('offers a retry when the list cannot load', async () => {
    vi.mocked(api.getPushSubscriptions).mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce({ subscriptions: [sub()] });
    render(<PushSubscriptionsList now={() => NOW} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('iPhone · Safari')).toBeTruthy();
  });

  it('turns the switch off on this device when the list no longer has its row (revoked from another device)', async () => {
    localStorage.setItem('dispatch:deviceId', 'me');
    useSettings.setState({ pushEnabled: true } as any);
    vi.mocked(api.getPushSubscriptions).mockResolvedValue({ subscriptions: [sub({ deviceId: 'other' })] });
    render(<PushSubscriptionsList now={() => NOW} />);
    await screen.findAllByTestId('push-row');
    await waitFor(() => expect(useSettings.getState().pushEnabled).toBe(false));
    expect(api.pushUnsubscribe).toHaveBeenCalledWith('me');
  });
});
