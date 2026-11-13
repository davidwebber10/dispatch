// The event stream of a company-system server opens only for a system the thread has a server for
// (os/tools-proxy.ts): a system the platform named for this person, inside the thread's own limit.
import { afterEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { KeyRegistry } from '../auth/principals.js';
import { createPrincipalMiddleware } from '../auth/request-principal.js';
import { nullKeyScope, type CallerFacts, type KeyScope } from '../auth/key-scope.js';
import { OsConnectionsProvider } from '../integrations/os-provider.js';
import { createOsToolsRouter, OsToolCatalog } from './tools-proxy.js';

const CONNECTIONS = {
  servers: [], env: {}, entitled: ['google'], profile: 'business',
  osPublicUrl: 'https://os.example', osTools: { url: 'https://os.internal/api/dispatch/mcp' }, needsConsent: [],
};
const caller = (id: string): CallerFacts => ({ id, sessionId: 's1', type: 'claude-code', role: null, depth: 0, spawnedBy: null, origin: null, roleRun: false, archived: false, overseer: false });
const scope: KeyScope = { ...nullKeyScope, caller: (id) => caller(id) };
const json = (o: unknown) => ({ status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify(o) });

const servers: http.Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) { s.closeAllConnections?.(); s.close(); } });

async function setup(systemsFor?: (terminalId: string) => string[] | null) {
  const osFetch = vi.fn(async (url: string, init: any) => {
    if (String(url).endsWith('/api/dispatch/connections')) return { ok: true, status: 200, json: async () => CONNECTIONS };
    const m = JSON.parse(init.body);
    if (m.method === 'tools/list') return json({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'google_connect', system: 'google' }, { name: 'acumatica_get_customer', system: 'acumatica' }, { name: 'os_list_connections', system: 'os' }] } });
    return json({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'os', version: '1' } } });
  });
  const provider = new OsConnectionsProvider({ baseUrl: 'https://os.internal', boxToken: 'os-box-token', ownerEmail: 'p@example.com', fetchImpl: osFetch as any, retryMinMs: 60_000 });
  await provider.refresh();
  const registry = new KeyRegistry();
  const catalog = new OsToolCatalog({ provider, fetchImpl: osFetch as any });
  await catalog.refresh();
  const app = express();
  app.use(express.json());
  app.use(createPrincipalMiddleware({ registry, scope }));
  app.use('/api', createOsToolsRouter({ provider, catalog, fetchImpl: osFetch as any, ...(systemsFor ? { systemsFor } : {}) }));
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const stream = async (system: string, key: string) => {
    const ac = new AbortController();
    const res = await fetch(`${base}/api/os/mcp/${system}`, { headers: { authorization: `Bearer ${key}`, accept: 'text/event-stream' }, signal: ac.signal });
    const out = { status: res.status, type: res.headers.get('content-type') ?? '', body: res.status === 200 ? null : await res.json() };
    ac.abort();
    return out;
  };
  return { registry, provider, stream };
}

describe('the event stream of a company system', () => {
  test('opens for a system the platform named for this person, and for the platform\'s own', async () => {
    const { registry, provider, stream } = await setup();
    const { key } = registry.mint({ kind: 'thread', terminalId: 't1' });
    for (const system of ['google', 'acumatica', 'os']) {
      const r = await stream(system, key);
      expect([system, r.status]).toEqual([system, 200]);
      expect(r.type).toMatch(/text\/event-stream/);
    }
    provider.stop();
  });

  test('a system the platform never named gets no stream', async () => {
    const { registry, provider, stream } = await setup();
    const { key } = registry.mint({ kind: 'thread', terminalId: 't1' });
    for (const system of ['payroll', 'zendesk', 'x']) {
      const r = await stream(system, key);
      expect([system, r.status]).toEqual([system, 404]);
      expect(r.body).toMatchObject({ error: 'unknown_system' });
    }
    provider.stop();
  });

  test('a thread limited to some systems gets no stream of another', async () => {
    const { registry, provider, stream } = await setup((id) => (id === 'limited' ? ['google'] : null));
    const limited = registry.mint({ kind: 'thread', terminalId: 'limited' }).key;
    const free = registry.mint({ kind: 'thread', terminalId: 'free' }).key;
    expect((await stream('google', limited)).status).toBe(200);
    const refused = await stream('acumatica', limited);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: 'not_permitted' });
    expect((await stream('os', limited)).status).toBe(200); // the platform's own server, always
    expect((await stream('acumatica', free)).status).toBe(200);
    provider.stop();
  });
});
