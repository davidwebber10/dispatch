import { describe, test, expect, vi } from 'vitest';
import { AuthRequestService } from './service.js';

function make(fetchImpl: typeof fetch) {
  const broadcaster = { broadcast: vi.fn() } as any;
  const service = new AuthRequestService(broadcaster, { fetch: fetchImpl });
  const req = service.create({ url: 'https://api.example.com/oauth/authorize?state=s1' });
  return { service, req };
}

describe('forwardLoopbackCallback', () => {
  test('accepts the scheme-less URL Safari copies from its address bar', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const { service, req } = make(fetchImpl as any);
    const out = await service.forwardLoopbackCallback(req.id, 'localhost:39461/oauth/callback?code=abc&state=s1');
    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:39461/oauth/callback?code=abc&state=s1', expect.anything());
    expect(out?.status).toBe('callback_forwarded');
  });

  test('a refused connection throws and leaves the request open for a retry', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const { service, req } = make(fetchImpl as any);
    await expect(service.forwardLoopbackCallback(req.id, 'http://localhost:1/cb?code=x')).rejects.toThrow(/sign-in .*no longer waiting/i);
    expect(service.get(req.id)?.status).toBe('pending');
  });

  test("the CLI rejecting the callback (stale state) surfaces as an error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('Invalid state', { status: 400 }));
    const { service, req } = make(fetchImpl as any);
    await expect(service.forwardLoopbackCallback(req.id, 'http://localhost:1/cb?code=x')).rejects.toThrow(/400/);
    expect(service.get(req.id)?.status).toBe('pending');
  });

  test('still refuses non-loopback hosts', async () => {
    const { service, req } = make(vi.fn() as any);
    await expect(service.forwardLoopbackCallback(req.id, 'evil.example.com/cb?code=x')).rejects.toThrow(/loopback/);
  });
});
