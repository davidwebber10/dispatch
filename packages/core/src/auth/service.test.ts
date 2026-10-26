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

describe('create', () => {
  test('a fresh sign-in supersedes an older pending one from the same terminal and endpoint', () => {
    const service = new AuthRequestService({ broadcast: vi.fn() } as any);
    const old = service.create({ url: 'https://api.example.com/oauth/authorize?state=a', terminalId: 't1' });
    const other = service.create({ url: 'https://other.example.com/oauth/authorize?state=b', terminalId: 't1' });
    const elsewhere = service.create({ url: 'https://api.example.com/oauth/authorize?state=c', terminalId: 't2' });
    service.create({ url: 'https://api.example.com/oauth/authorize?state=d', terminalId: 't1' });
    expect(service.get(old.id)?.status).toBe('completed');
    expect(service.get(other.id)?.status).toBe('pending');
    expect(service.get(elsewhere.id)?.status).toBe('pending');
  });
});
