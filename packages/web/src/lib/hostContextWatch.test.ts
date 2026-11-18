import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkHostContextNow, resetHostContextWatch, setHostContextForTest } from './hostContext';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('a profile change from OS reaches the page without a restart', () => {
  afterEach(() => { resetHostContextWatch(); setHostContextForTest(); });

  it('a hosted page reloads once when the daemon reports another profile', async () => {
    setHostContextForTest({ profile: 'business', hosted: true });
    const reload = vi.fn();
    const f = vi.fn(async () => json({ profile: 'developer', hosted: true, osBaseUrl: null, ownerEmail: null, capabilities: [] }));
    expect(await checkHostContextNow({ fetchImpl: f as never, reload, url: '/api/host-context' })).toBe(true);
    expect(await checkHostContextNow({ fetchImpl: f as never, reload, url: '/api/host-context' })).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('the same profile, the launcher HTML, a router 503 or 409 change nothing', async () => {
    setHostContextForTest({ profile: 'business', hosted: true });
    const reload = vi.fn();
    for (const r of [
      json({ profile: 'business', hosted: true }),
      new Response('<html>launcher</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      json({ error: 'box not ready', state: 'starting' }, 503),
      json({ error: 'x', reason: 'update-needed' }, 409),
    ]) {
      expect(await checkHostContextNow({ fetchImpl: (async () => r) as never, reload, url: '/x' })).toBe(false);
    }
    expect(reload).not.toHaveBeenCalled();
  });

  it('a local install never asks', async () => {
    setHostContextForTest({ profile: 'developer', hosted: false });
    const f = vi.fn();
    expect(await checkHostContextNow({ fetchImpl: f as never, reload: vi.fn(), url: '/x' })).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});
