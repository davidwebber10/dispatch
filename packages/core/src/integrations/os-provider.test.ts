import { describe, expect, test, vi } from 'vitest';
import { OsConnectionsProvider } from './os-provider.js';

const OK = {
  servers: [{ name: 'databricks', command: 'mcp-remote', args: ['https://mcp.polywood.tech/databricks'] }],
  env: { DATABRICKS_TOKEN: 'short-lived' },
  systemPrompt: 'A databricks MCP server is available.',
  needsConsent: [{ id: 'google', label: 'Google', connectUrl: '/connections/google' }],
};

function provider(fetchImpl: any, opts: Record<string, unknown> = {}) {
  return new OsConnectionsProvider({
    baseUrl: 'https://os.example', boxToken: 'tok', ownerEmail: 'a@b.c',
    fetchImpl, ...opts,
  });
}

describe('OsConnectionsProvider', () => {
  test('disabled without a base url or token — a local daemon brokers nothing', () => {
    const p = new OsConnectionsProvider({ baseUrl: undefined, boxToken: undefined, fetchImpl: vi.fn() as any });
    expect(p.enabled).toBe(false);
    expect(p.getServerSpecs()).toEqual([]);
    expect(p.getSpawnEnv()).toEqual({});
  });

  test('refresh() stores specs, env and prompt, and authenticates as the box', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => OK });
    const p = provider(f);
    const s = await p.refresh();
    expect(s.servers).toHaveLength(1);
    expect(s.reachable).toBe(true);
    expect(p.getSpawnEnv()).toEqual({ DATABRICKS_TOKEN: 'short-lived' });
    expect(p.getSystemPrompt()).toContain('databricks');
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://os.example/api/dispatch/connections');
    expect(init.headers['x-dispatch-box-token']).toBe('tok');
    expect(init.headers['x-dispatch-owner']).toBe('a@b.c');
  });

  test('an outage is distinguishable from "you have no tools"', async () => {
    // The whole point: collapsing these gives an agent that silently can't do
    // anything and can't explain why.
    const p = provider(vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const s = await p.refresh();
    expect(s.reachable).toBe(false);
    expect(s.error).toMatch(/ECONNREFUSED/);

    const empty = provider(vi.fn().mockResolvedValue({ ok: true, json: async () => ({ servers: [] }) }));
    const s2 = await empty.refresh();
    expect(s2.reachable).toBe(true);
    expect(s2.servers).toEqual([]);
    expect(s2.error).toBeNull();
  });

  test('a non-2xx is treated as unreachable, not as an empty tool set', async () => {
    const p = provider(vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));
    expect((await p.refresh()).reachable).toBe(false);
  });

  test('keeps the last good specs through an outage rather than disarming agents', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => OK })
      .mockRejectedValueOnce(new Error('boom'));
    const p = provider(f);
    await p.refresh();
    const s = await p.refresh();
    expect(s.servers).toHaveLength(1);   // retained
    expect(s.reachable).toBe(false);     // but flagged
  });

  test('getServerSpecs() is synchronous and serves cache within the TTL', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => OK });
    const p = provider(f, { ttlMs: 60_000 });
    await p.refresh();
    expect(p.getServerSpecs()).toHaveLength(1);
    expect(p.getServerSpecs()).toHaveLength(1);
    expect(f).toHaveBeenCalledTimes(1);  // no refetch inside the TTL
  });

  test('concurrent refreshes coalesce into one request', async () => {
    let resolve!: (v: any) => void;
    const f = vi.fn().mockImplementation(() => new Promise((r) => { resolve = r; }));
    const p = provider(f);
    const a = p.refresh(); const b = p.refresh();
    resolve({ ok: true, json: async () => OK });
    await Promise.all([a, b]);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
