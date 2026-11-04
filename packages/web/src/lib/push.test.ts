import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '../api/client';
import { useSettings } from '../stores/settings';
import { syncEnrollment, ensurePushEnrolled } from './push';

vi.mock('../api/client', async (orig) => {
  const real = await orig<typeof import('../api/client')>();
  return { ...real, api: { ...real.api, getPushSubscriptions: vi.fn(), pushUnsubscribe: vi.fn(), getPushKey: vi.fn() } };
});

const setPushEnabled = vi.fn();
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('dispatch:deviceId', 'me');
  setPushEnabled.mockReset().mockResolvedValue(undefined);
  vi.mocked(api.getPushSubscriptions).mockReset();
  useSettings.setState({ pushEnabled: true, setPushEnabled } as any);
});

describe('syncEnrollment: a revoked device notices', () => {
  it('turns the switch off when this device\'s row is gone from the daemon list', async () => {
    vi.mocked(api.getPushSubscriptions).mockResolvedValue({ subscriptions: [{ deviceId: 'other' }] } as any);
    expect(await syncEnrollment()).toBe(true);
    expect(setPushEnabled).toHaveBeenCalledWith(false);
  });

  it('leaves the switch on when the row is still there', async () => {
    vi.mocked(api.getPushSubscriptions).mockResolvedValue({ subscriptions: [{ deviceId: 'me' }] } as any);
    expect(await syncEnrollment()).toBe(false);
    expect(setPushEnabled).not.toHaveBeenCalled();
  });

  it('changes nothing when the list cannot be read, or the switch is already off', async () => {
    vi.mocked(api.getPushSubscriptions).mockRejectedValue(new Error('offline'));
    expect(await syncEnrollment()).toBe(false);
    useSettings.setState({ pushEnabled: false } as any);
    expect(await syncEnrollment()).toBe(false);
    expect(api.getPushSubscriptions).toHaveBeenCalledTimes(1);
    expect(setPushEnabled).not.toHaveBeenCalled();
  });

  it('uses a list the caller already fetched', async () => {
    expect(await syncEnrollment([{ deviceId: 'x' }])).toBe(true);
    expect(api.getPushSubscriptions).not.toHaveBeenCalled();
  });
});

describe('ensurePushEnrolled after a revoke', () => {
  it('enrolls again instead of returning early', async () => {
    vi.mocked(api.getPushSubscriptions).mockResolvedValue({ subscriptions: [] } as any);
    // Turning the switch off (as the real setPushEnabled(false) does) then asking to enroll calls setPushEnabled(true).
    setPushEnabled.mockImplementation(async (on: boolean) => { useSettings.setState({ pushEnabled: on } as any); });
    expect(await ensurePushEnrolled()).toBeNull();
    expect(setPushEnabled.mock.calls.map((c) => c[0])).toEqual([false, true]);
  });

  it('returns early when the row is still on the daemon', async () => {
    vi.mocked(api.getPushSubscriptions).mockResolvedValue({ subscriptions: [{ deviceId: 'me' }] } as any);
    expect(await ensurePushEnrolled()).toBeNull();
    expect(setPushEnabled).not.toHaveBeenCalled();
  });
});
