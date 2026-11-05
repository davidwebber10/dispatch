import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useUsageLimits } from './usageLimits';
import { api } from '../api/client';
import { resyncAfterReconnect } from '../lib/resync';

const body = { warnPercent: 80, providers: [{ provider: 'claude-code', asOf: 1, windows: { five_hour: { usedPercent: 46, resetsAt: 2 } } }], paused: [] };

beforeEach(() => {
  useUsageLimits.setState({ summary: null });
  vi.restoreAllMocks();
});

describe('useUsageLimits', () => {
  it('loads the summary', async () => {
    vi.spyOn(api, 'getUsageSummary').mockResolvedValue({ ...body, type: 'usage-limits' } as any);
    await useUsageLimits.getState().load();
    expect(useUsageLimits.getState().summary).toEqual(body);
  });

  it('a failed load keeps what is there', async () => {
    useUsageLimits.setState({ summary: body });
    vi.spyOn(api, 'getUsageSummary').mockRejectedValue(new Error('404'));
    await useUsageLimits.getState().load();
    expect(useUsageLimits.getState().summary).toEqual(body);
  });

  it('applies a usage-limits event and ignores others or a malformed one', () => {
    useUsageLimits.getState().applyEvent({ type: 'preview:new' });
    expect(useUsageLimits.getState().summary).toBeNull();
    useUsageLimits.getState().applyEvent({ type: 'usage-limits', warnPercent: 'x', providers: [], paused: [] });
    expect(useUsageLimits.getState().summary).toBeNull();
    useUsageLimits.getState().applyEvent({ type: 'usage-limits', ...body, warnPercent: 90 });
    expect(useUsageLimits.getState().summary).toEqual({ ...body, warnPercent: 90 });
  });

  it('reloads on a reconnect', async () => {
    const load = vi.spyOn(api, 'getUsageSummary').mockResolvedValue(body as any);
    await resyncAfterReconnect();
    expect(load).toHaveBeenCalledTimes(1);
    expect(useUsageLimits.getState().summary).toEqual(body);
  });
});
