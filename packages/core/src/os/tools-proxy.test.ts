import { afterEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { KeyRegistry } from '../auth/principals.js';
import { createPrincipalMiddleware } from '../auth/request-principal.js';
import { nullKeyScope, type CallerFacts, type KeyScope } from '../auth/key-scope.js';
import { OsConnectionsProvider } from '../integrations/os-provider.js';
import { createOsToolsRouter, osSystemServerSpecs, OsToolCatalog, systemsForSpawn, parseMcpBody, OS_UNREACHABLE_NOTICE, connectFollowUp, REFRESH_TOOL_DEF } from './tools-proxy.js';
import { createBridge, takeSseMessages } from './os-mcp-bridge.js';
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
  return { id, sessionId: 's1', type: id.startsWith('codex-') ? 'codex' : 'claude-code', role: null, depth: 0, spawnedBy: null, origin: null, roleRun: false, archived: false, overseer: false };
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
    // The gateway declared `tools: {}`; the box always declares listChanged (a harness subscribes only then).
    expect(init.result.capabilities).toEqual({ tools: { listChanged: true } });
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
  test('groups OS tools by system; a connect-only system gets a server too; OS own system is `connections`', async () => {
    const osFetch = vi.fn(async (_u: string, init: any) => {
      const m = JSON.parse(init.body);
      if (m.method === 'initialize') return json({ jsonrpc: '2.0', id: m.id, result: {} });
      expect(init.headers['x-dispatch-systems']).toBeUndefined();
      return json({ jsonrpc: '2.0', id: m.id, result: { tools: [
        { name: 'google_connect', system: 'google' }, { name: 'acumatica_get_customer' }, { name: 'acumatica_search_sales_orders' }, { name: 'os_list_connections' },
      ] } });
    });
    const { provider, catalog, registry, base } = await setup(osFetch, { catalog: true });
    // Before the first load: the entitled systems and OS's own.
    expect(systemsForSpawn(provider, catalog!)).toEqual(['google', 'os']);
    await catalog!.refresh();
    expect(catalog!.systems()).toEqual(['google', 'acumatica', 'os']);
    // google needs consent: its server has the one `connect` tool.
    expect(systemsForSpawn(provider, catalog!)).toEqual(['google', 'acumatica', 'os']);
    const specs = osSystemServerSpecs('http://127.0.0.1:3999/dispatch', systemsForSpawn(provider, catalog!));
    expect(specs.map((s) => [s.name, s.http?.url])).toEqual([
      ['google', 'http://127.0.0.1:3999/dispatch/api/os/mcp/google'],
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

describe('live tool changes (a system connected mid-thread)', () => {
  /** A gateway whose google tools are `connect` until `connected` is set. */
  function gateway() {
    const state = { connected: false, lists: 0 };
    const tools = () => [
      ...(state.connected
        ? [{ name: 'google_sheets_append', system: 'google', inputSchema: { type: 'object' } }, { name: 'google_sheets_create', system: 'google', inputSchema: { type: 'object' } }]
        : [{ name: 'google_connect', system: 'google', inputSchema: { type: 'object' } }]),
      { name: 'acumatica_get_customer', system: 'acumatica' },
      { name: 'os_list_connections', system: 'os' },
    ];
    const osFetch = vi.fn(async (_u: string, init: any) => {
      const m = JSON.parse(init.body);
      if (m.method === 'initialize') return json({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'os', version: '1' } } });
      if (m.method === 'tools/list') {
        state.lists++;
        const only = init.headers['x-dispatch-systems'];
        return json({ jsonrpc: '2.0', id: m.id, result: { tools: tools().filter((t) => !only || t.system === only) } });
      }
      if (m.method === 'tools/call' && m.params.name === 'google_connect') {
        return json({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: '{"error":"not_connected","system":"google","label":"Google","connect_url":"https://os.example/c/google"}' }] } });
      }
      return json({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: m.params.name }] } });
    });
    return { state, osFetch };
  }

  /** Read SSE events from a fetch body until `n` events or `ms` pass. */
  async function readEvents(res: Response, n: number, ms: number): Promise<unknown[]> {
    const reader = res.body!.getReader();
    const out: unknown[] = [];
    let buf = '';
    const deadline = Date.now() + ms;
    while (out.length < n && Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), Math.max(1, deadline - Date.now())))]);
      if (!chunk || chunk.done) break;
      buf += new TextDecoder().decode(chunk.value);
      const blocks = buf.split('\n\n');
      buf = blocks.pop() ?? '';
      for (const b of blocks) { const d = b.split('\n').find((l) => l.startsWith('data:')); if (d) out.push(JSON.parse(d.slice(5))); }
    }
    reader.cancel().catch(() => {});
    return out;
  }

  test('a connect-only system: its server lists `connect`; the call result gets the follow-up line and starts the fast watch', async () => {
    const { osFetch } = gateway();
    const { provider, catalog, registry, base } = await setup(osFetch, { catalog: true });
    await catalog!.refresh();
    expect(systemsForSpawn(provider, catalog!)).toEqual(['google', 'acumatica', 'os']);
    const { key } = registry.mint({ kind: 'thread', terminalId: 't-c' });
    const list = await (await post(base, 'google', key, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json();
    expect(list.result.tools.map((t: any) => t.name)).toEqual(['connect']);
    const call = await (await post(base, 'google', key, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'connect', arguments: {} } })).json();
    // OS's own content first, unchanged; then one line from the box.
    expect(call.result.content[0].text).toContain('not_connected');
    expect(call.result.content[1]).toEqual({ type: 'text', text: connectFollowUp('google') });
    expect(call.result.content[1].text).toContain('`refresh` tool of the `connections` server');
    expect(JSON.parse(osFetch.mock.calls.find((c) => JSON.parse(c[1].body).method === 'tools/call')![1].body).params.name).toBe('google_connect');
    expect(catalog!.watching()).toEqual(['google']);
    // Another system's ordinary tool gets no extra line and starts no watch.
    const other = await (await post(base, 'acumatica', key, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_customer' } })).json();
    expect(other.result.content).toHaveLength(1);
    // A Codex thread cannot load new tools mid-session (measured): its line says "a new thread".
    const codex = registry.mint({ kind: 'thread', terminalId: 'codex-1' }).key;
    const viaCodex = await (await post(base, 'google', codex, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'connect', arguments: {} } })).json();
    expect(viaCodex.result.content[1].text).toBe(connectFollowUp('google', false));
    expect(viaCodex.result.content[1].text).toContain('send the request again in a new thread');
    expect(viaCodex.result.content[1].text).not.toContain('by themselves');
    catalog!.stop();
    provider.stop();
  });

  test('list_changed goes on the event stream exactly when a system\'s tool set changes, not on every poll', async () => {
    const { state, osFetch } = gateway();
    const { provider, catalog, registry, base } = await setup(osFetch, { catalog: true });
    expect(await catalog!.refresh()).toEqual([]); // the first load is no change
    const changes: string[][] = [];
    catalog!.onToolsChanged((s) => changes.push(s));
    const { key } = registry.mint({ kind: 'thread', terminalId: 't-s' });
    // A GET without Accept: text/event-stream is still refused.
    expect((await fetch(`${base}/api/os/mcp/google`, { headers: { authorization: `Bearer ${key}` } })).status).toBe(405);
    const google = await fetch(`${base}/api/os/mcp/google`, { headers: { authorization: `Bearer ${key}`, accept: 'text/event-stream' } });
    expect(google.status).toBe(200);
    expect(google.headers.get('content-type')).toMatch(/text\/event-stream/);
    const acumatica = await fetch(`${base}/api/os/mcp/acumatica`, { headers: { authorization: `Bearer ${key}`, accept: 'text/event-stream' } });
    // Polls with the same answer: nothing.
    expect(await catalog!.refresh()).toEqual([]);
    expect(await catalog!.refresh()).toEqual([]);
    expect(changes).toEqual([]);
    // The person connects google.
    state.connected = true;
    expect(await catalog!.refresh()).toEqual(['google']);
    expect(changes).toEqual([['google']]);
    expect(await readEvents(google, 1, 1000)).toEqual([{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }]);
    expect(await readEvents(acumatica, 1, 150)).toEqual([]); // its tools did not change
    // The thread's next tools/list has the real tools.
    const list = await (await post(base, 'google', key, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json();
    expect(list.result.tools.map((t: any) => t.name)).toEqual(['sheets_append', 'sheets_create']);
    // A stream needs a thread key.
    expect((await fetch(`${base}/api/os/mcp/google`, { headers: { accept: 'text/event-stream' } })).status).toBe(403);
    provider.stop();
  });

  test('the platform signal: POST /api/os/connections/refresh refreshes the tool list too', async () => {
    const { state, osFetch } = gateway();
    const { provider, catalog, base } = await setup(osFetch, { catalog: true });
    await catalog!.refresh();
    const changes: string[][] = [];
    catalog!.onToolsChanged((s) => changes.push(s));
    state.connected = true;
    const res = await fetch(`${base}/api/os/connections/refresh`, { method: 'POST', headers: { 'user-agent': 'Mozilla/5.0', 'sec-fetch-site': 'same-origin' } });
    expect(res.status).toBe(200);
    expect(changes).toEqual([['google']]);
    provider.stop();
  });

  test('the `refresh` tool of the connections server: listed by the box, answered by the box, says what changed', async () => {
    const { state, osFetch } = gateway();
    const { provider, catalog, registry, base } = await setup(osFetch, { catalog: true });
    await catalog!.refresh();
    const { key } = registry.mint({ kind: 'thread', terminalId: 't-r' });
    const list = await (await post(base, 'os', key, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json();
    expect(list.result.tools.map((t: any) => t.name)).toEqual(['list', 'refresh']);
    expect(list.result.tools[1]).toEqual(REFRESH_TOOL_DEF);
    // Only the connections server has it.
    expect((await (await post(base, 'acumatica', key, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()).result.tools.map((t: any) => t.name)).toEqual(['get_customer']);
    const calls = () => osFetch.mock.calls.filter((c) => JSON.parse(c[1].body).method === 'tools/call').length;
    const before = calls();
    const still = await (await post(base, 'os', key, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'refresh', arguments: {} } })).json();
    expect(still.result.content[0].text).toContain('Nothing changed since the last check.');
    expect(still.result.content[0].text).toContain('Not connected yet: google.');
    state.connected = true;
    const now = await (await post(base, 'os', key, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'refresh', arguments: {} } })).json();
    expect(now.result.content[0].text).toContain('Changed now: google (tools: sheets_append, sheets_create).');
    expect(now.result.content[0].text).toContain('in a new thread');
    expect(calls()).toBe(before); // never forwarded to OS as a tool call
    provider.stop();
  });

  test('the fast re-check after `connect`: every 5 s for that system only, ends at the change (fake timers)', async () => {
    const { state, osFetch } = gateway();
    const connFetch = vi.fn(async (url: string, init: any) => (String(url).endsWith('/api/dispatch/connections')
      ? { ok: true, status: 200, json: async () => CONNECTIONS }
      : osFetch(url, init)));
    const provider = new OsConnectionsProvider({ baseUrl: 'https://os.internal', boxToken: 'os-box-token', fetchImpl: connFetch as any, retryMinMs: 60_000 });
    await provider.refresh();
    const catalog = new OsToolCatalog({ provider, fetchImpl: connFetch as any });
    await catalog.refresh();
    const changes: string[][] = [];
    catalog.onToolsChanged((s) => changes.push(s));
    vi.useFakeTimers();
    try {
      const listsBefore = state.lists;
      catalog.watchAfterConnect('google');
      await vi.advanceTimersByTimeAsync(0); // the check right after the call
      expect(state.lists).toBe(listsBefore + 1);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(state.lists).toBe(listsBefore + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(state.lists).toBe(listsBefore + 2);
      // Each check asks for google only.
      const last = osFetch.mock.calls[osFetch.mock.calls.length - 1][1];
      expect(last.headers['x-dispatch-systems']).toBe('google');
      expect(changes).toEqual([]);
      state.connected = true;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(changes).toEqual([['google']]);
      expect(catalog.watching()).toEqual([]);
      const after = state.lists;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(state.lists).toBe(after); // the watch ended
    } finally { vi.useRealTimers(); catalog.stop(); provider.stop(); }
  });

  test('the fast re-check gives up after 5 minutes when the person does not connect', async () => {
    const { state, osFetch } = gateway();
    const connFetch = vi.fn(async (url: string, init: any) => (String(url).endsWith('/api/dispatch/connections')
      ? { ok: true, status: 200, json: async () => CONNECTIONS }
      : osFetch(url, init)));
    const provider = new OsConnectionsProvider({ baseUrl: 'https://os.internal', boxToken: 'os-box-token', fetchImpl: connFetch as any, retryMinMs: 60_000 });
    await provider.refresh();
    const catalog = new OsToolCatalog({ provider, fetchImpl: connFetch as any });
    await catalog.refresh();
    vi.useFakeTimers();
    try {
      const before = state.lists;
      catalog.watchAfterConnect('google');
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 5_000);
      expect(catalog.watching()).toEqual([]);
      expect(state.lists - before).toBe(61); // once at once, then every 5 s for 5 minutes
      await vi.advanceTimersByTimeAsync(60_000);
      expect(state.lists - before).toBe(61);
    } finally { vi.useRealTimers(); catalog.stop(); provider.stop(); }
  });
});

describe('built-in systems and the gateway instructions', () => {
  test('data and display become servers from tools/list; instructions ride data only, renamed; results pass byte for byte', async () => {
    const TEXT = 'Call data_guide first. Put the marker from display_chart on its own line.';
    const RESULT = { content: [{ type: 'text', text: 'Chart ready.\n[[chart:abc-123]]\n' }], structuredContent: { id: 'abc-123', kind: 'chart', rows: 3 } };
    const osFetch = vi.fn(async (_u: string, init: any) => {
      const m = JSON.parse(init.body);
      if (m.method === 'initialize') return json({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'os', version: '1' }, instructions: TEXT } });
      if (m.method === 'tools/list') return json({ jsonrpc: '2.0', id: m.id, result: { tools: [
        { name: 'data_query', system: 'data' }, { name: 'data_guide', system: 'data' }, { name: 'display_chart', system: 'display' },
        { name: 'acumatica_get_customer', system: 'acumatica' }, { name: 'os_list_connections', system: 'os' },
      ] } });
      return json({ jsonrpc: '2.0', id: m.id, result: RESULT });
    });
    const { provider, catalog, registry, base } = await setup(osFetch, { catalog: true });
    await catalog!.refresh();
    expect(catalog!.systems()).toEqual(['data', 'display', 'acumatica', 'os']);
    expect(systemsForSpawn(provider, catalog!)).toEqual(['data', 'display', 'acumatica', 'os']);
    const { key } = registry.mint({ kind: 'thread', terminalId: 't-7' });
    const init = (sys: string) => post(base, sys, key, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }).then((r) => r.json());
    expect((await init('data')).result.instructions).toBe('Call data.guide first. Put the marker from display.chart on its own line.');
    expect((await init('display')).result.instructions).not.toContain('guide');
    expect((await init('os')).result.instructions).not.toContain('guide');
    const list = await (await post(base, 'display', key, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    expect(list.result.tools.map((t: any) => t.name)).toEqual(['chart']);
    const raw = await (await post(base, 'display', key, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'chart', arguments: {} } })).text();
    expect(JSON.parse(raw).result).toEqual(RESULT);
    expect(raw).toContain(JSON.stringify(RESULT.content[0].text));
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

describe('the bridge passes the event stream on (stdio harnesses)', () => {
  test('takeSseMessages keeps a half event for the next chunk', () => {
    const a = takeSseMessages(': open\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"x"}\n\nevent: mes');
    expect(a.messages).toEqual([{ jsonrpc: '2.0', method: 'x' }]);
    expect(a.rest).toBe('event: mes');
  });

  test('after initialize it opens GET with Accept: text/event-stream and writes each notification as a line; a 405 daemon is left alone', async () => {
    const out: string[] = [];
    let push: ((s: string) => void) | null = null;
    const body = new ReadableStream<Uint8Array>({ start(c) { push = (s) => c.enqueue(new TextEncoder().encode(s)); } });
    const fetchImpl = vi.fn(async (_u: string, init: any) => {
      if (init.method === 'GET') return { status: 200, body, text: async () => '' };
      const msg = JSON.parse(init.body);
      return { status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } } } }) };
    });
    const b = createBridge({ api: 'http://127.0.0.1:1/dispatch', system: 'google', write: (l) => out.push(l), fetchImpl: fetchImpl as any, headers: () => ({ Authorization: 'Bearer k' }), stream: true });
    await b.line(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }));
    await new Promise((r) => setTimeout(r, 10));
    const get = fetchImpl.mock.calls.find((c) => (c[1] as any).method === 'GET')!;
    expect(get[0]).toBe('http://127.0.0.1:1/dispatch/api/os/mcp/google');
    expect((get[1] as any).headers).toMatchObject({ accept: 'text/event-stream', Authorization: 'Bearer k', 'mcp-protocol-version': '2025-06-18' });
    push!(': open\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n');
    await new Promise((r) => setTimeout(r, 10));
    expect(out.map((l) => JSON.parse(l))).toEqual([
      { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } } } },
      { jsonrpc: '2.0', method: 'notifications/tools/list_changed' },
    ]);
    b.stop();

    // An older daemon (405): no retry loop.
    const old = vi.fn(async (_u: string, init: any) => (init.method === 'GET'
      ? { status: 405, text: async () => '' }
      : { status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) }));
    const b2 = createBridge({ api: 'http://127.0.0.1:1', system: 'google', write: () => {}, fetchImpl: old as any, headers: () => ({}), stream: true, streamRetryMs: 1 });
    await b2.line(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }));
    await new Promise((r) => setTimeout(r, 30));
    expect(old.mock.calls.filter((c) => (c[1] as any).method === 'GET')).toHaveLength(1);
    b2.stop();
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
