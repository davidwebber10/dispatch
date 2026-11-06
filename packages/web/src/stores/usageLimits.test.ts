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

  it('a slow GET answered after a newer event does not undo it', async () => {
    let resolveGet!: (v: unknown) => void;
    vi.spyOn(api, 'getUsageSummary').mockReturnValue(new Promise((r) => { resolveGet = r; }) as any);
    const loading = useUsageLimits.getState().load();
    // A pause event (built at 200) arrives while the GET (built at 100) is still in flight.
    useUsageLimits.getState().applyEvent({ type: 'usage-limits', ...body, at: 200, paused: [{ provider: 'claude-code' }] });
    resolveGet({ ...body, type: 'usage-limits', at: 100, paused: [] });
    await loading;
    expect(useUsageLimits.getState().summary?.paused).toHaveLength(1);
  });

  it('an older event does not undo a newer GET; a newer one wins', async () => {
    vi.spyOn(api, 'getUsageSummary').mockResolvedValue({ ...body, type: 'usage-limits', at: 300, warnPercent: 70 } as any);
    await useUsageLimits.getState().load();
    useUsageLimits.getState().applyEvent({ type: 'usage-limits', ...body, at: 250, warnPercent: 99 });
    expect(useUsageLimits.getState().summary?.warnPercent).toBe(70);
    useUsageLimits.getState().applyEvent({ type: 'usage-limits', ...body, at: 301, warnPercent: 85 });
    expect(useUsageLimits.getState().summary?.warnPercent).toBe(85);
  });

  it('a body with no stamp (an older daemon) is always applied', () => {
    useUsageLimits.getState().applyEvent({ type: 'usage-limits', ...body, at: 500 });
    useUsageLimits.getState().applyEvent({ type: 'usage-limits', ...body, warnPercent: 60 });
    expect(useUsageLimits.getState().summary?.warnPercent).toBe(60);
  });

  it('reloads on a reconnect', async () => {
    const load = vi.spyOn(api, 'getUsageSummary').mockResolvedValue(body as any);
    await resyncAfterReconnect();
    expect(load).toHaveBeenCalledTimes(1);
    expect(useUsageLimits.getState().summary).toEqual(body);
  });
});
