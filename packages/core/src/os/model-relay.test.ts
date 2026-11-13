import { afterEach, describe, expect, test } from 'vitest';
import express from 'express';
import http from 'node:http';
import { KeyRegistry } from '../auth/principals.js';
import { createPrincipalMiddleware } from '../auth/request-principal.js';
import { nullKeyScope, type CallerFacts, type KeyScope } from '../auth/key-scope.js';
import { createJsonBody } from '../http/json-body.js';
import { parseModelAccess, type ModelAccess } from './company-model.js';
import { COMPANY_MODEL_UNREACHABLE, createModelRelayRouter } from './model-relay.js';

const MODEL = 'claude-opus-5-5';
const ACCESS = parseModelAccess({ models: [MODEL], default: MODEL, subscriptions: { claude: false }, seatFirst: true, modelHarness: { [MODEL]: 'claude-code' } })!;

function caller(id: string): CallerFacts {
  return { id, sessionId: 's1', type: 'claude-code', role: null, depth: 0, spawnedBy: null, origin: null, roleRun: false, archived: false, overseer: false };
}
const scope: KeyScope = { ...nullKeyScope, caller: (id) => caller(id) };

const servers: http.Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) { s.closeAllConnections?.(); s.close(); } });

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as any).port}`;
}

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }

async function setup(upstream: http.RequestListener | null, opts: {
  access?: ModelAccess | null;
  threads?: Record<string, { type: string; config: Record<string, unknown> } | null>;
  timeouts?: { totalMs?: number; headersMs?: number; idleMs?: number };
} = {}) {
  const seen: Seen[] = [];
  let osBase = 'http://127.0.0.1:1'; // nothing listens there
  if (upstream) {
    osBase = await listen((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { seen.push({ method: req.method!, url: req.url!, headers: req.headers, body }); upstream(req, res); });
    });
  }
  const registry = new KeyRegistry();
  const threads = opts.threads ?? { 't-1': { type: 'claude-code', config: { model: MODEL, modelSource: 'company' } } };
  const app = express();
  app.use(createJsonBody());
  app.use(createPrincipalMiddleware({ registry, scope, getToken: () => 'owner-token' }));
  app.use('/api', createModelRelayRouter({
    access: () => (opts.access === undefined ? ACCESS : opts.access),
    proxy: () => ({ anthropicBaseUrl: `${osBase}/api/dispatch/model/anthropic`, openaiBaseUrl: null, usageUrl: null }),
    boxHeaders: () => ({ 'x-dispatch-box-token': 'os-box-token', 'x-dispatch-owner': 'p@example.com' }),
    thread: (id) => threads[id] ?? null,
    ...opts.timeouts,
  }));
  const base = await listen(app);
  return { registry, base, seen };
}

const send = (base: string, key: string | null, body: unknown, extra: Record<string, string> = {}, path = '/v1/messages') =>
  fetch(`${base}/api/os-model/anthropic${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'b1,b2', ...(key ? { authorization: `Bearer ${key}` } : {}), ...extra },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('the company model relay', () => {
  test('forwards the body unchanged with the box headers and the thread id from the key; only four caller headers', async () => {
    const { registry, base, seen } = await setup((_req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'x-other': '1' }); res.end('{"id":"msg_1"}'); });
    const { key } = registry.mint({ kind: 'thread', terminalId: 't-1' });
    const raw = `{"model":"${MODEL}","max_tokens":5,  "messages":[]}`;
    const r = await send(base, key, raw, { cookie: 'c=1', 'x-api-key': 'k', 'x-dispatch-thread-id': 'forged', 'x-dispatch-box-token': 'forged', 'accept-encoding': 'gzip' });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('{"id":"msg_1"}');
    expect(r.headers.get('x-other')).toBeNull();
    expect(seen).toHaveLength(1);
    const s = seen[0];
    expect(s.url).toBe('/api/dispatch/model/anthropic/v1/messages');
    expect(s.body).toBe(raw);
    expect(s.headers['x-dispatch-box-token']).toBe('os-box-token');
    expect(s.headers['x-dispatch-owner']).toBe('p@example.com');
    expect(s.headers['x-dispatch-thread-id']).toBe('t-1');
    expect(s.headers['anthropic-version']).toBe('2023-06-01');
    expect(s.headers['anthropic-beta']).toBe('b1,b2');
    expect(s.headers.authorization).toBeUndefined();
    expect(s.headers['x-api-key']).toBeUndefined();
    expect(s.headers.cookie).toBeUndefined();
    expect(s.headers['accept-encoding']).toBe('identity');
  });

  test('count_tokens goes to its own path', async () => {
    const { registry, base, seen } = await setup((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":3}'); });
    const { key } = registry.mint({ kind: 'thread', terminalId: 't-1' });
    const r = await send(base, key, { model: MODEL, messages: [] }, {}, '/v1/messages/count_tokens');
    expect(await r.json()).toEqual({ input_tokens: 3 });
    expect(seen[0].url).toBe('/api/dispatch/model/anthropic/v1/messages/count_tokens');
  });

  test('streams SSE chunk by chunk, with status, content-type, retry-after and x-dispatch-refusal', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { registry, base } = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '3', 'x-dispatch-refusal': 'none' });
      res.write(': keepalive\n\nevent: message_start\ndata: {"type":"message_start"}\n\n');
      void gate.then(() => { res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n'); });
    });
    const { key } = registry.mint({ kind: 'thread', terminalId: 't-1' });
    const r = await send(base, key, { model: MODEL, stream: true, messages: [] });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/event-stream');
    expect(r.headers.get('retry-after')).toBe('3');
    expect(r.headers.get('x-dispatch-refusal')).toBe('none');
    const reader = r.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('message_start'); // arrived before the platform finished
    release();
    let rest = '';
    for (;;) { const { done, value } = await reader.read(); if (done) break; rest += new TextDecoder().decode(value); }
    expect(rest).toContain('message_stop');
  });

  test('a platform error passes through as is; a platform 401 becomes 503 with the plain sentence', async () => {
    let status = 429;
    const { registry, base } = await setup((_req, res) => { res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '9', 'x-should-retry': 'false' }); res.end('{"type":"error","error":{"type":"rate_limit_error","message":"Your budget is used up."}}'); });
    const { key } = registry.mint({ kind: 'thread', terminalId: 't-1' });
    const r = await send(base, key, { model: MODEL });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('9');
    // The weekly limit: Claude Code shows the message at once instead of retrying.
    expect(r.headers.get('x-should-retry')).toBe('false');
    expect((await r.json()).error.message).toBe('Your budget is used up.');
    status = 401;
    const r2 = await send(base, key, { model: MODEL });
    expect(r2.status).toBe(503);
    expect(await r2.json()).toEqual({ type: 'error', error: { type: 'overloaded_error', message: COMPANY_MODEL_UNREACHABLE } });
  });

  test('the platform cannot be reached: 503 with the plain sentence, and the request is sent once', async () => {
    const { registry, base } = await setup(null);
    const { key } = registry.mint({ kind: 'thread', terminalId: 't-1' });
    const r = await send(base, key, { model: MODEL });
    expect(r.status).toBe(503);
    expect((await r.json()).error.message).toBe(COMPANY_MODEL_UNREACHABLE);
    let calls = 0;
    const s2 = await setup((req, res) => { calls++; req.socket.destroy(); void res; });
    const k2 = s2.registry.mint({ kind: 'thread', terminalId: 't-1' }).key;
    expect((await send(s2.base, k2, { model: MODEL })).status).toBe(503);
    expect(calls).toBe(1);
  });

  test('no status line in time: 503', async () => {
    const { registry, base } = await setup(() => { /* never answers */ }, { timeouts: { headersMs: 100 } });
    const { key } = registry.mint({ kind: 'thread', terminalId: 't-1' });
    expect((await send(base, key, { model: MODEL })).status).toBe(503);
  });

  test('the caller goes away: the platform request is aborted', async () => {
    let closed!: () => void;
    const upstreamClosed = new Promise<void>((r) => { closed = r; });
    const { registry, base } = await setup((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': keepalive\n\n');
      req.socket.on('close', () => closed());
    });
    const { key } = registry.mint({ kind: 'thread', terminalId: 't-1' });
    const ac = new AbortController();
    const r = await fetch(`${base}/api/os-model/anthropic/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ model: MODEL, stream: true }), signal: ac.signal });
    await r.body!.getReader().read();
    ac.abort();
    await upstreamClosed;
  });

  test('refusals: owner, no credential, another kind of key, a non-company thread, a revoked grant, another model, a body over 8 MB', async () => {
    const { registry, base, seen } = await setup((_req, res) => { res.writeHead(200); res.end('{}'); }, {
      threads: {
        't-1': { type: 'claude-code', config: { model: MODEL, modelSource: 'company' } },
        't-2': { type: 'claude-code', config: { model: MODEL } },
        't-3': { type: 'codex', config: { model: MODEL, modelSource: 'company' } },
      },
    });
    const key1 = registry.mint({ kind: 'thread', terminalId: 't-1' }).key;
    const expect403 = async (r: Response) => { expect(r.status).toBe(403); expect((await r.json()).type).toBe('error'); };
    await expect403(await send(base, 'owner-token', { model: MODEL }).then((r) => r));
    await expect403(await send(base, null, { model: MODEL }));
    await expect403(await send(base, registry.mint({ kind: 'chat', startedBy: 'user' }).key, { model: MODEL }));
    await expect403(await send(base, registry.mint({ kind: 'thread', terminalId: 't-2' }).key, { model: MODEL }));
    await expect403(await send(base, registry.mint({ kind: 'thread', terminalId: 't-3' }).key, { model: MODEL }));
    await expect403(await send(base, registry.mint({ kind: 'thread', terminalId: 't-gone' }).key, { model: MODEL }));
    await expect403(await send(base, key1, { model: 'claude-sonnet-4' }));
    const big = await send(base, key1, `{"model":"${MODEL}","x":"${'a'.repeat(8 * 1024 * 1024)}"}`);
    expect(big.status).toBe(413);
    expect((await big.json()).error.type).toBe('request_too_large');
    expect(seen).toHaveLength(0);
    const revoked = await setup(null, { access: parseModelAccess({ models: [], modelHarness: { [MODEL]: 'claude-code' } }) });
    await expect403(await send(revoked.base, revoked.registry.mint({ kind: 'thread', terminalId: 't-1' }).key, { model: MODEL }));
    const none = await setup(null, { access: null });
    await expect403(await send(none.base, none.registry.mint({ kind: 'thread', terminalId: 't-1' }).key, { model: MODEL }));
  });
});
