import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useHost } from './host';
import { api } from '../api/client';

describe('useHost', () => {
  beforeEach(() => {
    useHost.setState({ platform: null, canReveal: false, fileManagerName: null });
    vi.restoreAllMocks();
  });

  it('loads the daemon capability', async () => {
    vi.spyOn(api, 'getHost').mockResolvedValue({
      platform: 'darwin',
      flavor: 'macos',
      fileManagerName: 'Finder',
      canReveal: true,
    });
    await useHost.getState().load();
    expect(useHost.getState()).toMatchObject({ platform: 'darwin', canReveal: true, fileManagerName: 'Finder' });
  });

  it('resets to incapable when the probe fails — never offer what we cannot confirm', async () => {
    useHost.setState({ platform: 'darwin', canReveal: true, fileManagerName: 'Finder' });
    vi.spyOn(api, 'getHost').mockRejectedValue(new Error('offline'));
    await useHost.getState().load();
    expect(useHost.getState().canReveal).toBe(false);
    expect(useHost.getState().platform).toBeNull();
    expect(useHost.getState().fileManagerName).toBeNull();
  });
});
