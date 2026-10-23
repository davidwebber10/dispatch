import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createAccessGate } from './access-gate.js';
import { createAccessConfig } from './known-hosts.js';
import { COOKIE_NAME, cookieValue, createTokenSource, rotateAccessToken } from './access-token.js';
import { securityHeaders } from './security-headers.js';

let dir: string;
let peer: string;

function build(basePath = '') {
  const getToken = createTokenSource(dir);
  const gate = createAccessGate({
    getToken, isGatewayPeer: () => false, config: createAccessConfig(dir),
    tailscale: { self: async () => null, isOwnerPeer: async () => false },
    basePath,
  });
  const app = express();
  app.use((req, _res, next) => { Object.defineProperty(req.socket, 'remoteAddress', { value: peer, configurable: true }); next(); });
  app.use(securityHeaders);
  app.post('/api/access/login', ...gate.loginRoute);
  app.use(gate.middleware);
  app.get('/api/x', (_req, res) => { res.json({ ok: true }); });
  app.post('/api/x', (_req, res) => { res.json({ ok: true }); });
  app.get('/page', (_req, res) => { res.send('app'); });
  return { app, getToken };
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-gate-')); peer = '192.168.1.9'; });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const LAN = 'http://192.168.1.5:3456';

describe('refusals', () => {
  test('LAN API call: 401 JSON', async () => {
    const { app } = build();
    const r = await request(app).get('/api/x').set('Host', '192.168.1.5:3456');
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'auth_required' });
    expect(r.headers['cache-control']).toContain('no-store');
  });
  test('LAN page: 401 sign-in page with the form and the security headers', async () => {
    const { app } = build();
    const r = await request(app).get('/page').set('Host', '192.168.1.5:3456').set('Accept', 'text/html');
    expect(r.status).toBe(401);
    expect(r.text).toContain('id="t"');
    expect(r.headers['x-frame-options']).toBe('DENY');
    // The page script is inline: its policy must allow it by hash, or no remote device could sign in.
    expect(r.headers['content-security-policy']).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
  });
  test('LAN POST outside /api: 401 JSON, not the page', async () => {
    const { app } = build();
    const r = await request(app).post('/page').set('Host', '192.168.1.5:3456');
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'auth_required' });
  });
  test('loopback with a foreign Host (rebinding): 401', async () => {
    peer = '127.0.0.1';
    const { app } = build();
    expect((await request(app).get('/api/x').set('Host', 'evil.example:3456')).status).toBe(401);
  });
  test('loopback + localhost passes with no credential', async () => {
    peer = '127.0.0.1';
    const { app } = build();
    expect((await request(app).get('/api/x').set('Host', 'localhost:3456')).status).toBe(200);
  });
  test('SEC-03: foreign-Origin text/plain POST from the owner browser is 403', async () => {
    peer = '127.0.0.1';
    const { app } = build();
    const r = await request(app).post('/api/x').set('Host', 'localhost:3456')
      .set('Origin', 'http://evil.example').set('Content-Type', 'text/plain');
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'origin_refused' });
  });
});

describe('hardening', () => {
  test('/API/x with a cross-site label is treated as the API and refused', async () => {
    peer = '127.0.0.1';
    const { app } = build();
    app.get('/API/x', (_req, res) => { res.json({ ok: true }); });
    const r = await request(app).get('/API/x').set('Host', 'localhost:3456').set('Sec-Fetch-Site', 'cross-site');
    expect(r.status).toBe(403);
  });
  test('the base path cannot break out of the sign-in script', async () => {
    const { app } = build('/x</script><script>alert(1)');
    const r = await request(app).get('/page').set('Host', '192.168.1.5:3456');
    expect(r.text).not.toContain('</script><script>alert(1)');
  });
  test('behind a same-machine proxy, one visitor failing does not lock out another', async () => {
    peer = '127.0.0.1';
    const { app, getToken } = build();
    const login = (xff: string, token: string) => request(app).post('/api/access/login')
      .set('Host', 'localhost:3456').set('X-Forwarded-For', xff).send({ token });
    for (let i = 0; i < 10; i++) await login('203.0.113.9', 'nope');
    expect((await login('203.0.113.9', 'nope')).status).toBe(429);
    expect((await login('198.51.100.2', getToken())).status).toBe(200);
  });
});

describe('relay headers seen from the wire', () => {
  const serve = (headers: Record<string, string>) => {
    peer = '127.0.0.1';
    const getToken = createTokenSource(dir);
    const gate = createAccessGate({
      getToken, isGatewayPeer: () => false, config: createAccessConfig(dir),
      tailscale: {
        self: async () => ({ userId: 1, login: 'me@example.com', names: ['mac.tail1.ts.net'], ips: [] }),
        isOwnerPeer: async (a) => a === '100.64.0.2',
      },
      basePath: '',
    });
    const app = express();
    app.use((req, _res, next) => { Object.defineProperty(req.socket, 'remoteAddress', { value: peer, configurable: true }); next(); });
    app.use(gate.middleware);
    app.get('/api/x', (_req, res) => { res.json({ ok: true }); });
    return request(app).get('/api/x').set('Host', 'mac.tail1.ts.net').set('Tailscale-User-Login', 'me@example.com').set(headers);
  };
  test('a real serve request (single owner X-Forwarded-For) passes', async () => {
    expect((await serve({ 'X-Forwarded-For': '100.64.0.2' })).status).toBe(200);
  });
  test.each([
    ['empty X-Forwarded-For', { 'X-Forwarded-For': '' }],
    ['empty Forwarded', { Forwarded: '' }],
    ['X-Real-IP only', { 'X-Real-IP': '100.64.0.2' }],
    ['a chain ending in an owner address', { 'X-Forwarded-For': '203.0.113.4, 100.64.0.2' }],
    ['a non-owner address', { 'X-Forwarded-For': '203.0.113.4' }],
    ['an empty Funnel header', { 'X-Forwarded-For': '100.64.0.2', 'Tailscale-Funnel-Request': '' }],
  ])('is refused: %s', async (_n, headers) => {
    expect((await serve(headers)).status).toBe(401);
  });
});

describe('login body errors', () => {
  test('malformed and oversized bodies get a JSON error, never a stack trace', async () => {
    const { app } = build();
    const bad = await request(app).post('/api/access/login').set('Host', '192.168.1.5:3456').set('Content-Type', 'application/json').send('{bad');
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'bad_request' });
    const big = await request(app).post('/api/access/login').set('Host', '192.168.1.5:3456').send({ token: 'x'.repeat(10000) });
    expect(big.status).toBe(413);
    expect(big.text).not.toContain('node_modules');
  });
  test('the limiter keys on the last X-Forwarded-For entry, which a client cannot choose', async () => {
    peer = '127.0.0.1';
    const { app, getToken } = build();
    const login = (xff: string, token: string) => request(app).post('/api/access/login')
      .set('Host', 'localhost:3456').set('X-Forwarded-For', xff).send({ token });
    for (let i = 0; i < 10; i++) await login(`spoof${i}, 203.0.113.9`, 'nope');
    expect((await login('anything, 203.0.113.9', 'nope')).status).toBe(429);
  });
});

describe('login', () => {
  const login = (app: express.Express, token: string, extra: Record<string, string> = {}) =>
    request(app).post('/api/access/login').set('Host', '192.168.1.5:3456').set(extra).send({ token });

  test('good token sets an HttpOnly SameSite=Lax cookie that then opens the API; token is not echoed', async () => {
    const { app, getToken } = build();
    const r = await login(app, getToken());
    expect(r.status).toBe(200);
    const cookie = String(r.headers['set-cookie']);
    expect(cookie).toContain(`${COOKIE_NAME}=${cookieValue(getToken())}`);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Max-Age=34560000/);
    expect(cookie).not.toMatch(/Secure/);
    expect(JSON.stringify(r.body)).not.toContain(getToken());
    const ok = await request(app).get('/api/x').set('Host', '192.168.1.5:3456').set('Cookie', `${COOKIE_NAME}=${cookieValue(getToken())}`);
    expect(ok.status).toBe(200);
  });
  test('Secure only when a loopback proxy says https', async () => {
    peer = '127.0.0.1';
    const { app, getToken } = build();
    const r = await request(app).post('/api/access/login').set('Host', 'localhost:3456')
      .set('X-Forwarded-Proto', 'https').send({ token: getToken() });
    expect(String(r.headers['set-cookie'])).toMatch(/Secure/);
    peer = '192.168.1.9';
    const r2 = await login(app, getToken(), { 'X-Forwarded-Proto': 'https' });
    expect(String(r2.headers['set-cookie'])).not.toMatch(/Secure/);
  });
  test('cookie path follows the base path', async () => {
    const { app, getToken } = build('/dispatch');
    const r = await login(app, getToken());
    expect(String(r.headers['set-cookie'])).toContain('Path=/dispatch');
  });
  test('wrong token: 401; 10 failures per minute then 429, even for the right token', async () => {
    const { app, getToken } = build();
    for (let i = 0; i < 10; i++) expect((await login(app, 'nope')).status).toBe(401);
    expect((await login(app, 'nope')).status).toBe(429);
    expect((await login(app, getToken())).status).toBe(429);
    peer = '192.168.1.10'; // another peer is not limited
    expect((await login(app, getToken())).status).toBe(200);
  });
  test('missing or non-string token: 401', async () => {
    const { app } = build();
    expect((await request(app).post('/api/access/login').set('Host', '192.168.1.5:3456').send({})).status).toBe(401);
    expect((await login(app, 123 as unknown as string)).status).toBe(401);
  });
  test('foreign Origin: 403 even with the right token', async () => {
    const { app, getToken } = build();
    const r = await login(app, getToken(), { Origin: 'http://evil.example' });
    expect(r.status).toBe(403);
  });
  test('same-origin LAN Origin is fine', async () => {
    const { app, getToken } = build();
    expect((await login(app, getToken(), { Origin: LAN })).status).toBe(200);
  });
});

describe('rotation', () => {
  test('a cookie made from the old token stops working', async () => {
    const { app, getToken } = build();
    const old = cookieValue(getToken());
    const call = () => request(app).get('/api/x').set('Host', '192.168.1.5:3456').set('Cookie', `${COOKIE_NAME}=${old}`);
    expect((await call()).status).toBe(200);
    await new Promise((r) => setTimeout(r, 15)); // distinct mtime
    rotateAccessToken(dir);
    expect((await call()).status).toBe(401);
  });
});
