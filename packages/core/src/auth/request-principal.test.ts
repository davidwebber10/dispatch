import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createAccessGate } from './access-gate.js';
import { createAccessConfig } from './known-hosts.js';
import { COOKIE_NAME, cookieValue, createTokenSource } from './access-token.js';
import { KeyRegistry } from './principals.js';
import { nullKeyScope, type CallerFacts, type KeyScope } from './key-scope.js';
import {
  bearerKey, createLoginKeyCheck, createPrincipalMiddleware, principalOf, refuseKeyUpgrade, scopeOf, whoamiHandler,
} from './request-principal.js';
import { createNoCredentialStats } from './no-credential-stats.js';
import { BOX_TOKEN_HEADER } from './box-token.js';

let dir: string;
let peer: string;
let clock: number;
let lines: string[];

const facts = (over: Partial<CallerFacts> = {}): CallerFacts => ({
  id: 't1', sessionId: 's1', type: 'claude-code', role: 'coordinator', depth: 1, spawnedBy: null,
  origin: null, roleRun: false, archived: false, overseer: true, ...over,
});

function build(opts: { scope?: KeyScope; box?: string; withGate?: boolean } = {}) {
  const registry = new KeyRegistry();
  const getToken = createTokenSource(dir);
  const stats = createNoCredentialStats({ log: (l) => lines.push(l), now: () => clock });
  const gate = createAccessGate({
    getToken, isGatewayPeer: () => false, config: createAccessConfig(dir),
    tailscale: { self: async () => null, isOwnerPeer: async () => false }, basePath: '',
  });
  const app = express();
  app.use((req, _res, next) => { Object.defineProperty(req.socket, 'remoteAddress', { value: peer, configurable: true }); next(); });
  app.post('/api/access/login', createLoginKeyCheck({ registry, log: (l) => lines.push(l), now: () => clock }), ...gate.loginRoute);
  app.use(gate.middleware);
  app.use(createPrincipalMiddleware({
    registry, scope: opts.scope ?? nullKeyScope, getToken, boxToken: opts.box, stats,
    log: (l) => lines.push(l), now: () => clock,
  }));
  app.use(express.json());
  app.get('/api/p', (req, res) => { res.json(principalOf(req)); });
  app.get('/api/whoami', whoamiHandler);
  app.get('/api/terminals/:id', (_req, res) => { res.json({}); });
  app.get('/page', (_req, res) => { res.send('page'); });
  return { app, registry, getToken, stats };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-rp-'));
  peer = '127.0.0.1';
  clock = 1_000_000;
  lines = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const H = { Host: 'localhost' };

describe('bearerKey', () => {
  test('returns key-shaped values only', () => {
    const k = 'dtk_' + 'A'.repeat(43);
    expect(bearerKey(`Bearer ${k}`)).toBe(k);
    expect(bearerKey('Bearer dtk_short')).toBe('dtk_short');
    expect(bearerKey('Bearer ${DISPATCH_AUTH}')).toBeNull();
    expect(bearerKey('Bearer abc')).toBeNull();
    expect(bearerKey(undefined)).toBeNull();
    expect(bearerKey('Basic dtk_x')).toBeNull();
  });
});

describe('principal middleware', () => {
  test('a live thread key attaches the thread principal', async () => {
    const { app, registry } = build();
    const { key, handle } = registry.mint({ kind: 'thread', terminalId: 't1' });
    const r = await request(app).get('/api/p').set(H).set('Authorization', `Bearer ${key}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ kind: 'thread', terminalId: 't1', handle });
  });

  test('a revoked key gives 401 auth_required', async () => {
    const { app, registry } = build();
    const { key, handle } = registry.mint({ kind: 'thread', terminalId: 't1' });
    registry.revoke(handle);
    const r = await request(app).get('/api/p').set(H).set('Authorization', `Bearer ${key}`);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('auth_required');
    expect(r.body.message).toContain('Start a new thread');
  });

  test('a key plus a valid cookie, or the access token, is judged as the key', async () => {
    const { app, registry, getToken } = build();
    const { key } = registry.mint({ kind: 'thread', terminalId: 't1' });
    const cookie = `${COOKIE_NAME}=${cookieValue(getToken())}`;
    const a = await request(app).get('/api/p').set(H).set('Cookie', cookie).set('Authorization', `Bearer ${key}`);
    expect(a.body.kind).toBe('thread');
    const b = await request(app).get('/api/p').set(H).set('Authorization', `Bearer ${key}`).set('X-Other', getToken());
    expect(b.body.kind).toBe('thread');
  });

  test('a key on a page gives 403 owner_only', async () => {
    const { app, registry } = build();
    const { key } = registry.mint({ kind: 'thread', terminalId: 't1' });
    const r = await request(app).get('/page').set(H).set('Authorization', `Bearer ${key}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('owner_only');
  });

  test('the access token attaches owner via token; the cookie via cookie', async () => {
    const { app, getToken } = build();
    const t = await request(app).get('/api/p').set(H).set('Authorization', `Bearer ${getToken()}`);
    expect(t.body).toEqual({ kind: 'owner', via: 'token' });
    const c = await request(app).get('/api/p').set(H).set('Cookie', `${COOKIE_NAME}=${cookieValue(getToken())}`);
    expect(c.body).toEqual({ kind: 'owner', via: 'cookie' });
  });

  test('no credential from loopback is none/local and counted', async () => {
    const { app, stats } = build();
    const r = await request(app).get('/api/p').set(H);
    expect(r.body).toEqual({ kind: 'none', via: 'local' });
    expect(stats.snapshot().program.total).toBe(1);
  });

  test('a literal placeholder Bearer value is ignored and counted', async () => {
    const { app, stats } = build();
    const r = await request(app).get('/api/p').set(H).set('Authorization', 'Bearer ${DISPATCH_AUTH}');
    expect(r.body).toEqual({ kind: 'none', via: 'local' });
    expect(stats.snapshot().program.total).toBe(1);
  });

  test('a box header attaches owner via box', async () => {
    const { app } = build({ box: 'boxsecret' });
    const r = await request(app).get('/api/p').set(H).set(BOX_TOKEN_HEADER, 'boxsecret');
    expect(r.body).toEqual({ kind: 'owner', via: 'box' });
  });

  test('scopeOf returns the scope given to the middleware', async () => {
    const scope = { ...nullKeyScope };
    const registry = new KeyRegistry();
    const app = express();
    app.use(createPrincipalMiddleware({ registry, scope, via: 'test' }));
    app.get('/api/s', (req, res) => { res.json({ same: scopeOf(req) === scope, p: principalOf(req) }); });
    const r = await request(app).get('/api/s');
    expect(r.body).toEqual({ same: true, p: { kind: 'none', via: 'test' } });
  });

  test('principalOf throws when the middleware did not run', () => {
    expect(() => principalOf({} as express.Request)).toThrow();
  });
});

describe('login order', () => {
  const login = (app: express.Express, headers: Record<string, string> = {}, token?: string) =>
    request(app).post('/api/access/login').set(H).set(headers).send({ token });

  test('a live key with the right token gets 403 and no cookie', async () => {
    const { app, registry, getToken } = build();
    const { key } = registry.mint({ kind: 'thread', terminalId: 't1' });
    const r = await login(app, { Authorization: `Bearer ${key}` }, getToken());
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('owner_only');
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  test('a revoked key gets 401', async () => {
    const { app, registry, getToken } = build();
    const { key, handle } = registry.mint({ kind: 'thread', terminalId: 't1' });
    registry.revoke(handle);
    const r = await login(app, { Authorization: `Bearer ${key}` }, getToken());
    expect(r.status).toBe(401);
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  test('a credential-free login with the right token sets the cookie, from loopback and from a LAN peer', async () => {
    const { app, getToken } = build();
    const a = await login(app, {}, getToken());
    expect(a.status).toBe(200);
    expect(String(a.headers['set-cookie'])).toContain(COOKIE_NAME);
    peer = '192.168.1.9';
    const b = await request(app).post('/api/access/login').set('Host', '192.168.1.5:3456').send({ token: getToken() });
    expect(b.status).toBe(200);
    expect(String(b.headers['set-cookie'])).toContain(COOKIE_NAME);
    const other = await request(app).get('/api/p').set('Host', '192.168.1.5:3456');
    expect(other.status).toBe(401);
  });
});

describe('refusal log', () => {
  test('20 calls with one revoked key give one line, then a count line a minute later', async () => {
    const { app, registry } = build();
    const { key, handle } = registry.mint({ kind: 'thread', terminalId: 't1' });
    registry.revoke(handle);
    for (let i = 0; i < 20; i++) await request(app).get('/api/p').set(H).set('Authorization', `Bearer ${key}`);
    const refusals = () => lines.filter((l) => l.includes('refused'));
    expect(refusals()).toHaveLength(1);
    clock += 61_000;
    await request(app).get('/api/p').set(H).set('Authorization', `Bearer ${key}`);
    expect(refusals()).toHaveLength(2);
    expect(refusals()[1]).toContain('20 more');
    expect(lines.join('\n')).not.toContain(key);
  });
});

describe('refusal log with a key in the path', () => {
  test('the line holds neither the header key nor a key written into the URL', async () => {
    const { app, registry } = build();
    const a = registry.mint({ kind: 'thread', terminalId: 't1' });
    const b = registry.mint({ kind: 'thread', terminalId: 't2' });
    registry.revoke(a.handle);
    await request(app).get(`/api/terminals/${b.key}`).set(H).set('Authorization', `Bearer ${a.key}`);
    await request(app).post(`/api/access/login`).set(H).set('Authorization', `Bearer ${a.key}`).send({});
    const refusals = lines.filter((l) => l.includes('refused'));
    expect(refusals.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(a.key);
    expect(lines.join('\n')).not.toContain(b.key);
  });
});

describe('stats', () => {
  test('Sec-Fetch-Mode counts as browser, none as program', async () => {
    const { app, stats } = build();
    await request(app).get('/api/p').set(H).set('Sec-Fetch-Mode', 'cors');
    await request(app).get('/api/p').set(H);
    const s = stats.snapshot();
    expect(s.browser.total).toBe(1);
    expect(s.program.total).toBe(1);
  });

  test('ten requests to a UUID path give one pattern and one log line', async () => {
    const { app, stats } = build();
    for (let i = 0; i < 10; i++) {
      await request(app).get(`/api/terminals/3f2b8c1e-9a4d-4e0b-8c55-1a2b3c4d5e6f`).set(H);
    }
    const s = stats.snapshot();
    expect(s.program.top).toEqual([{ pattern: 'GET /api/terminals/:id', count: 10 }]);
    expect(lines.filter((l) => l.startsWith('[keys] no-credential program'))).toHaveLength(1);
  });

  test('the hourly summary appears after an hour', async () => {
    const { app } = build();
    await request(app).get('/api/p').set(H);
    const before = lines.length;
    await request(app).get('/api/p').set(H);
    expect(lines.length).toBe(before);
    clock += 61 * 60_000;
    await request(app).get('/api/p').set(H);
    expect(lines.length).toBe(before + 1);
    expect(lines[lines.length - 1]).toContain('summary');
  });
});

describe('whoami', () => {
  test('thread key returns the caller facts', async () => {
    const scope: KeyScope = { ...nullKeyScope, caller: (id) => (id === 't1' ? facts() : null) };
    const { app, registry } = build({ scope });
    const { key } = registry.mint({ kind: 'thread', terminalId: 't1' });
    const r = await request(app).get('/api/whoami').set(H).set('Authorization', `Bearer ${key}`);
    expect(r.body).toEqual({
      kind: 'thread', terminalId: 't1', sessionId: 's1', role: 'coordinator', depth: 1,
      spawnedBy: null, roleRun: false, overseer: true,
    });
  });
  test('chat, shell and owner shapes', async () => {
    const { app, registry, getToken } = build();
    const c = registry.mint({ kind: 'chat', startedBy: 'report' });
    const s = registry.mint({ kind: 'shell', terminalId: 'sh1' });
    expect((await request(app).get('/api/whoami').set(H).set('Authorization', `Bearer ${c.key}`)).body)
      .toEqual({ kind: 'chat', startedBy: 'report' });
    expect((await request(app).get('/api/whoami').set(H).set('Authorization', `Bearer ${s.key}`)).body)
      .toEqual({ kind: 'shell', terminalId: 'sh1' });
    expect((await request(app).get('/api/whoami').set(H).set('Authorization', `Bearer ${getToken()}`)).body)
      .toEqual({ kind: 'owner' });
    expect((await request(app).get('/api/whoami').set(H)).body).toEqual({ kind: 'none' });
  });
});

describe('refuseKeyUpgrade', () => {
  test('refuses an upgrade that carries a key', () => {
    const k = 'dtk_' + 'A'.repeat(43);
    expect(refuseKeyUpgrade({ headers: { authorization: `Bearer ${k}` } } as never)).toBe(true);
    expect(refuseKeyUpgrade({ headers: { authorization: 'Bearer dtk_x' } } as never)).toBe(true);
    expect(refuseKeyUpgrade({ headers: { authorization: 'Bearer plain' } } as never)).toBe(false);
    expect(refuseKeyUpgrade({ headers: {} } as never)).toBe(false);
  });
});
