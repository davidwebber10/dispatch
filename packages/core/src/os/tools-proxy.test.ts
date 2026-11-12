import { afterEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { KeyRegistry } from '../auth/principals.js';
import { createPrincipalMiddleware } from '../auth/request-principal.js';
import { nullKeyScope, type CallerFacts, type KeyScope } from '../auth/key-scope.js';
import { OsConnectionsProvider } from '../integrations/os-provider.js';
import { createOsToolsRouter, osSystemServerSpecs, OsToolCatalog, systemsForSpawn, parseMcpBody, OS_UNREACHABLE_NOTICE } from './tools-proxy.js';
import { createBridge } from './os-mcp-bridge.js';
import { composeInjection } from '../mcp/injection.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONNECTIONS = {
  servers: [], env: {}, systemPrompt: 'Use the company tools.', entitled: ['google'], profile: 'business',
  osPublicUrl: 'https://os.example', osTools: { url: 'https://os.internal/api/dispatch/mcp' },
  needsConsent: [{ system: 'google', label: 'Google', connectUrl: 'https://os.example/connections/google' }],
};

function caller(id: string): CallerFacts {
  return { id, sessionId: 's1', type: 'claude-code', role: null, depth: 0, spawnedBy: null, origin: null, roleRun: false, archived: false, overseer: false };
}
const scope: KeyScope = { ...nullKeyScope, caller: (id) => caller(id) };

const servers: http.Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

async function setup(osFetch: (url: string, init: any) => Promise<any>, opts: { catalog?: boolean } = {}) {
  const connFetch = vi.fn(async (url: string, init: any) => (String(url).endsWith('/api/dispatch/connections')
    ? { ok: true, status: 200, json: async () => CONNECTIONS }
    : osFetch(url, init)));
  const provider = new OsConnectionsProvider({ baseUrl: 'https://os.internal', boxToken: 'os-box-token', ownerEmail: 'p@example.com', fetchImpl: connFetch as any, retryMinMs: 60_000 });
  await provider.refresh();
  const registry = new KeyRegistry();
  const notices: Array<[string, string]> = [];
  const app = express();
  app.use(express.json());
  app.use(createPrincipalMiddleware({ registry, scope }));
  const catalog = opts.catalog ? new OsToolCatalog({ provider, fetchImpl: connFetch as any }) : undefined;
  app.use('/api', createOsToolsRouter({ provider, catalog, fetchImpl: connFetch as any, onUnreachable: (t, m) => notices.push([t, m]) }));
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  return { provider, registry, notices, base: `http://127.0.0.1:${port}`, connFetch, catalog };
}

const json = (o: unknown) => ({ status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify(o) });
const post = (base: string, sys: string, key: string | null, body: unknown) =>
  fetch(`${base}/api/os/mcp/${sys}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });

describe('company-system proxy (one route per system)', () => {
  test('tools/list: the systems filter header, only that system, the prefix dropped; box token added, never the thread key', async () => {
    const osFetch = vi.fn(async (_url: string, _init: any) => json({ jsonrpc: '2.0', id: 1, result: { tools: [
      { name: 'zendesk_search_tickets', description: 'd', inputSchema: { type: 'object' } },
      { name: 'os_list_connections', inputSchema: { type: 'object' } },
      { name: 'acumatica_get_customer', system: 'acumatica', inputSchema: { type: 'object' } },
    ] } }));
    const { registry, base } = await setup(osFetch);
    const { key } = registry.mint({ kind: 'thread', terminalId: 't-42' });
    const res = await post(base, 'zendesk', key, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'search_tickets', description: 'd', inputSchema: { type: 'object' } }] } });
    const [url, init] = osFetch.mock.calls[0];
    expect(url).toBe('https://os.internal/api/dispatch/mcp');
    expect(init.headers['x-dispatch-box-token']).toBe('os-box-token');
    expect(init.headers['x-dispatch-owner']).toBe('p@example.com');
    expect(init.headers['x-dispatch-thread-id']).toBe('t-42');
    expect(init.headers['x-dispatch-systems']).toBe('zendesk');
    expect(init.headers.authorization).toBeUndefined();
    // OS's own system: `connections` with the tool `list`.
    const conn = await (await post(base, 'os', key, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    expect(conn.result.tools.map((t: any) => t.name)).toEqual(['list']);
    expect(osFetch.mock.calls[1][1].headers['x-dispatch-systems']).toBe('os');
  });

  test('tools/call: the thread name maps back to the gateway name; initialize names the server after the system', async () => {
    const osFetch = vi.fn(async (_url: string, init: any) => {
      const m = JSON.parse(init.body);
      if (m.method === 'initialize') return json({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'os', version: '7' } } });
      return json({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: m.params.name }] } });
    });
    const { registry, base } = await setup(osFetch);
    const { key } = registry.mint({ kind: 'thread', terminalId: 't-1' });
    const init = await (await post(base, 'google_drive', key, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json();
    expect(init.result.serverInfo).toEqual({ name: 'google-drive', version: '7' });
    const call = await (await post(base, 'google_drive', key, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_files', arguments: { q: 'x' } } })).json();
    expect(call.result.content[0].text).toBe('google_drive_search_files');
    const body = JSON.parse(osFetch.mock.calls[1][1].body);
    expect(body.params).toEqual({ name: 'google_drive_search_files', arguments: { q: 'x' } });
    const list = await (await post(base, 'os', key, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list' } })).json();
    expect(list.result.content[0].text).toBe('os_list_connections');
    // A notification: 202, nothing forwarded.
    const n = osFetch.mock.calls.length;
    expect((await post(base, 'google_drive', key, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    expect(osFetch.mock.calls.length).toBe(n);
    // No server-initiated stream on this route.
    expect((await fetch(`${base}/api/os/mcp/google_drive`, { headers: { authorization: `Bearer ${key}` } })).status).toBe(405);
  });

  test('a thread limited to some systems gets no tools from another', async () => {
    const osFetch = vi.fn();
    const connFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => CONNECTIONS }));
    const provider = new OsConnectionsProvider({ baseUrl: 'https://os.internal', boxToken: 'os-box-token', fetchImpl: connFetch as any });
    await provider.refresh();
    const registry = new KeyRegistry();
    const app = express();
    app.use(express.json());
    app.use(createPrincipalMiddleware({ registry, scope }));
    app.use('/api', createOsToolsRouter({ provider, fetchImpl: osFetch as any, systemsFor: () => ['acumatica'] }));
    const server = http.createServer(app); servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const { key } = registry.mint({ kind: 'thread', terminalId: 't-9' });
    expect((await (await post(base, 'zendesk', key, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()).result.tools).toEqual([]);
    expect(osFetch).not.toHaveBeenCalled();
  });

  test('refuses a caller with no thread key, and an unknown key', async () => {
    const { base } = await setup(vi.fn());
    const none = await post(base, 'zendesk', null, {});
    expect(none.status).toBe(403);
    const bad = await post(base, 'zendesk', `dtk_${'a'.repeat(43)}`, {});
    expect(bad.status).toBe(401);
  });

  test('OS unreachable: a plain tool error, the provider is flagged, and the thread gets ONE notice', async () => {
    const { registry, base, provider, notices } = await setup(vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const { key } = registry.mint({ kind: 'thread', terminalId: 't-1' });
    for (let i = 0; i < 2; i++) {
      const res = await post(base, 'zendesk', key, { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'x' } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result.isError).toBe(true);
      expect(JSON.parse(body.result.content[0].text)).toEqual({ error: 'os_unreachable', message: OS_UNREACHABLE_NOTICE });
    }
    // initialize is answered locally, so a thread that starts now still gets its server.
    const init = await (await post(base, 'zendesk', key, { jsonrpc: '2.0', id: 9, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json();
    expect(init.result.serverInfo.name).toBe('zendesk');
    expect(provider.snapshot().reachable).toBe(false);
    expect(notices).toEqual([['t-1', OS_UNREACHABLE_NOTICE]]);
    provider.stop();
  });

  test('GET /api/os/connections shows the consent cards and profile, never env or tokens', async () => {
    const { base } = await setup(vi.fn());
    const body = await (await fetch(`${base}/api/os/connections`)).json();
    expect(body).toMatchObject({ hosted: true, reachable: true, profile: 'business', osToolsEnabled: true, entitled: ['google'] });
    expect(body.needsConsent).toEqual([{ system: 'google', label: 'Google', connectUrl: 'https://os.example/connections/google' }]);
    expect(JSON.stringify(body)).not.toContain('os-box-token');
  });

  test('parseMcpBody reads an SSE answer', () => {
    expect(parseMcpBody('text/event-stream', 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n')).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(parseMcpBody('application/json', '')).toBeNull();
  });
});

describe('the catalog', () => {
  test('groups OS tools by system; a system that needs consent gets no server; OS own system is `connections`', async () => {
    const osFetch = vi.fn(async (_u: string, init: any) => {
      const m = JSON.parse(init.body);
      if (m.method === 'initialize') return json({ jsonrpc: '2.0', id: m.id, result: {} });
      expect(init.headers['x-dispatch-systems']).toBeUndefined();
      return json({ jsonrpc: '2.0', id: m.id, result: { tools: [
        { name: 'google_search_mail', system: 'google' }, { name: 'acumatica_get_customer' }, { name: 'acumatica_search_sales_orders' }, { name: 'os_list_connections' },
      ] } });
    });
    const { provider, catalog, registry, base } = await setup(osFetch, { catalog: true });
    // Before the first load: the entitled systems (minus consent) and OS's own.
    expect(systemsForSpawn(provider, catalog!)).toEqual(['os']);
    await catalog!.refresh();
    expect(catalog!.systems()).toEqual(['google', 'acumatica', 'os']);
    expect(systemsForSpawn(provider, catalog!)).toEqual(['acumatica', 'os']); // google needs consent
    const specs = osSystemServerSpecs('http://127.0.0.1:3999/dispatch', systemsForSpawn(provider, catalog!));
    expect(specs.map((s) => [s.name, s.http?.url])).toEqual([
      ['acumatica', 'http://127.0.0.1:3999/dispatch/api/os/mcp/acumatica'],
      ['connections', 'http://127.0.0.1:3999/dispatch/api/os/mcp/os'],
    ]);
    // OS away: tools/list answers from the catalog.
    osFetch.mockImplementation(async () => { throw new Error('ECONNREFUSED'); });
    const { key } = registry.mint({ kind: 'thread', terminalId: 't-3' });
    const list = await (await post(base, 'acumatica', key, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json();
    expect(list.result.tools.map((t: any) => t.name)).toEqual(['get_customer', 'search_sales_orders']);
    provider.stop();
  });
});

describe('the company-system bridge (stdio form)', () => {
  const mk = (status: number, body: unknown) => vi.fn(async () => ({ status, text: async () => (body === null ? '' : JSON.stringify(body)) }));

  test('passes answers through and keeps the not_connected result as OS wrote it', async () => {
    const out: string[] = [];
    const result = { isError: true, content: [{ type: 'text', text: '{"error":"not_connected","system":"google","connectPath":"/connections/google"}' }] };
    const fetchImpl = mk(200, { jsonrpc: '2.0', id: 3, result });
    const b = createBridge({ api: 'http://127.0.0.1:1/dispatch', system: 'google', write: (l) => out.push(l), fetchImpl: fetchImpl as any, headers: () => ({ Authorization: 'Bearer k' }) });
    await b.line(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'send' } }));
    expect(JSON.parse(out[0])).toEqual({ jsonrpc: '2.0', id: 3, result });
    expect((fetchImpl.mock.calls[0] as any[])[0]).toBe('http://127.0.0.1:1/dispatch/api/os/mcp/google');
  });

  test('OS away: a local initialize, an empty list, a plain tool error; then list_changed when it comes back', async () => {
    const out: string[] = [];
    let up = false;
    const fetchImpl = vi.fn(async (_u: string, init: any) => {
      const msg = JSON.parse(init.body);
      if (!up) return { status: 502, text: async () => JSON.stringify({ error: 'os_unreachable', message: 'Company tools are not reachable right now.' }) };
      return { status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'a' }] } }) };
    });
    const b = createBridge({ api: 'http://127.0.0.1:1', system: 'google_drive', write: (l) => out.push(l), fetchImpl: fetchImpl as any, headers: () => ({}), retryMs: 5 });
    await b.line(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }));
    await b.line(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    await b.line(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    await b.line(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'a' } }));
    const msgs = out.map((l) => JSON.parse(l));
    expect(msgs[0].result.serverInfo.name).toBe('google-drive');
    expect(msgs[1]).toEqual({ jsonrpc: '2.0', id: 2, result: { tools: [] } });
    expect(msgs[2].result.isError).toBe(true);
    expect(JSON.parse(msgs[2].result.content[0].text).error).toBe('os_unreachable');
    up = true;
    await new Promise((r) => setTimeout(r, 40));
    expect(out.map((l) => JSON.parse(l)).some((m) => m.method === 'notifications/tools/list_changed')).toBe(true);
    b.stop();
  });
});

describe('company-system injection', () => {
  test('a key variable: loopback HTTP entries with the key as a reference; a key file: the stdio bridge; no file holds a key or the box token', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-sys-inj-'));
    const specs = osSystemServerSpecs('http://127.0.0.1:3999/dispatch', ['acumatica', 'google_drive', 'os']);
    const inj = composeInjection(specs, { configPath: path.join(dir, 'thread-t.mcp.json'), prompts: ['Use the company tools.'] });
    const raw = fs.readFileSync(inj.claudeConfigPath!, 'utf8');
    const file = JSON.parse(raw);
    expect(Object.keys(file.mcpServers)).toEqual(['acumatica', 'google-drive', 'connections']);
    expect(file.mcpServers['google-drive']).toEqual({ type: 'http', url: 'http://127.0.0.1:3999/dispatch/api/os/mcp/google_drive', headers: { Authorization: 'Bearer ${DISPATCH_AUTH}' } });
    expect(inj.codexArgs).toContain('mcp_servers.acumatica.bearer_token_env_var="DISPATCH_AUTH"');
    expect(raw).not.toMatch(/dtk_|os-box-token|os-tools/);
    // The Codex CLI view (key file): one stdio bridge per system.
    const viaFile = composeInjection(specs, { configPath: path.join(dir, 'thread-u.mcp.json'), prompts: [], authVar: 'DISPATCH_AUTH_FILE' });
    expect(viaFile.codexArgs).toContain('mcp_servers.acumatica.env_vars=["DISPATCH_AUTH_FILE"]');
    expect(viaFile.codexArgs).toContain('mcp_servers.acumatica.env.DISPATCH_OS_SYSTEM="acumatica"');
    expect(viaFile.codexArgs.join(' ')).toMatch(/os-mcp-bridge\.js/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
