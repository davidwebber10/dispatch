import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useHost } from './host';
import { api } from '../api/client';

describe('useHost', () => {
  beforeEach(() => {
    useHost.setState({ platform: null, canReveal: false });
    vi.restoreAllMocks();
  });

  it('loads the daemon capability', async () => {
    vi.spyOn(api, 'getHost').mockResolvedValue({ platform: 'darwin', canReveal: true });
    await useHost.getState().load();
    expect(useHost.getState()).toMatchObject({ platform: 'darwin', canReveal: true });
  });

  it('stays incapable when the probe fails — Reveal just never offers itself', async () => {
    vi.spyOn(api, 'getHost').mockRejectedValue(new Error('offline'));
    await useHost.getState().load();
    expect(useHost.getState().canReveal).toBe(false);
  });
});
