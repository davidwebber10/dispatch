import { afterEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { KeyRegistry } from '../auth/principals.js';
import { createPrincipalMiddleware } from '../auth/request-principal.js';
import { nullKeyScope, type CallerFacts, type KeyScope } from '../auth/key-scope.js';
import { OsConnectionsProvider } from '../integrations/os-provider.js';
import { createOsToolsRouter, osToolsServerSpec, parseMcpBody, OS_UNREACHABLE_NOTICE } from './tools-proxy.js';
import { createBridge } from './os-tools-mcp.js';
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

async function setup(osFetch: (url: string, init: any) => Promise<any>) {
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
  app.use('/api', createOsToolsRouter({ provider, fetchImpl: connFetch as any, onUnreachable: (t, m) => notices.push([t, m]) }));
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  return { provider, registry, notices, base: `http://127.0.0.1:${port}`, connFetch };
}

describe('os-tools proxy', () => {
  test('forwards a thread call to OS with the box token, the owner and the thread id; the thread never sees the box token', async () => {
    const osFetch = vi.fn(async (_url: string, _init: any) => ({ status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'zendesk_search' }] } }) }));
    const { registry, base } = await setup(osFetch);
    const { key } = registry.mint({ kind: 'thread', terminalId: 't-42' });
    const res = await fetch(`${base}/api/os-tools/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'zendesk_search' }] } });
    const [url, init] = osFetch.mock.calls[0];
    expect(url).toBe('https://os.internal/api/dispatch/mcp');
    expect(init.headers['x-dispatch-box-token']).toBe('os-box-token');
    expect(init.headers['x-dispatch-owner']).toBe('p@example.com');
    expect(init.headers['x-dispatch-thread-id']).toBe('t-42');
    expect(init.headers.authorization).toBeUndefined();
  });

  test('refuses a caller with no thread key, and an unknown key', async () => {
    const { base } = await setup(vi.fn());
    const none = await fetch(`${base}/api/os-tools/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(none.status).toBe(403);
    const bad = await fetch(`${base}/api/os-tools/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer dtk_${'a'.repeat(43)}` }, body: '{}' });
    expect(bad.status).toBe(401);
  });

  test('OS unreachable: 502 with a plain message, the provider is flagged, and the thread gets ONE notice', async () => {
    const { registry, base, provider, notices } = await setup(vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const { key } = registry.mint({ kind: 'thread', terminalId: 't-1' });
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${base}/api/os-tools/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'x' } }) });
      expect(res.status).toBe(502);
      expect((await res.json()).message).toBe(OS_UNREACHABLE_NOTICE);
    }
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

describe('the os-tools bridge', () => {
  const mk = (status: number, body: unknown) => vi.fn(async () => ({ status, text: async () => (body === null ? '' : JSON.stringify(body)) }));

  test('passes answers through and keeps the not_connected result as OS wrote it', async () => {
    const out: string[] = [];
    const result = { isError: true, content: [{ type: 'text', text: '{"error":"not_connected","system":"google","connectPath":"/connections/google"}' }] };
    const b = createBridge({ api: 'http://127.0.0.1:1', write: (l) => out.push(l), fetchImpl: mk(200, { jsonrpc: '2.0', id: 3, result }) as any, headers: () => ({ Authorization: 'Bearer k' }) });
    await b.line(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gmail_send' } }));
    expect(JSON.parse(out[0])).toEqual({ jsonrpc: '2.0', id: 3, result });
  });

  test('OS away: a local initialize, an empty list, a plain tool error; then list_changed when it comes back', async () => {
    const out: string[] = [];
    let up = false;
    const fetchImpl = vi.fn(async (_u: string, init: any) => {
      const msg = JSON.parse(init.body);
      if (!up) return { status: 502, text: async () => JSON.stringify({ error: 'os_unreachable', message: 'Company tools are not reachable right now.' }) };
      return { status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'a' }] } }) };
    });
    const b = createBridge({ api: 'http://127.0.0.1:1', write: (l) => out.push(l), fetchImpl: fetchImpl as any, headers: () => ({}), retryMs: 5 });
    await b.line(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }));
    await b.line(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    await b.line(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    await b.line(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'a' } }));
    const msgs = out.map((l) => JSON.parse(l));
    expect(msgs[0].result.serverInfo.name).toBe('os-tools');
    expect(msgs[1]).toEqual({ jsonrpc: '2.0', id: 2, result: { tools: [] } });
    expect(msgs[2].result.isError).toBe(true);
    expect(JSON.parse(msgs[2].result.content[0].text).error).toBe('os_unreachable');
    up = true;
    await new Promise((r) => setTimeout(r, 40));
    expect(out.map((l) => JSON.parse(l)).some((m) => m.method === 'notifications/tools/list_changed')).toBe(true);
    b.stop();
  });
});

describe('os-tools injection', () => {
  test('every harness gets the bridge with the key as a reference; no file holds a key or the box token', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-tools-inj-'));
    const spec = osToolsServerSpec('http://127.0.0.1:3999/dispatch');
    const inj = composeInjection([spec], { configPath: path.join(dir, 'thread-t.mcp.json'), prompts: ['Use the company tools.'] });
    const file = JSON.parse(fs.readFileSync(inj.claudeConfigPath!, 'utf8'));
    expect(file.mcpServers['os-tools'].env).toEqual({ DISPATCH_API: 'http://127.0.0.1:3999/dispatch', DISPATCH_AUTH: '${DISPATCH_AUTH}' });
    expect(file.mcpServers['os-tools'].args[0]).toMatch(/os-tools-mcp\.js$/);
    expect(inj.codexArgs).toContain('mcp_servers.os-tools.env_vars=["DISPATCH_AUTH"]');
    expect(inj.systemPrompt).toContain('Use the company tools.');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
