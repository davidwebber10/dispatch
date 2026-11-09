import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { createAccessGate } from './access-gate.js';
import { createAccessConfig } from './known-hosts.js';
import { createTokenSource } from './access-token.js';
import { createCfAccessVerifier, type Jwk } from './cf-access.js';

// W1-C, end to end through the real middleware, the real access.json and the real verifier:
// only the key fetch is a fake (keys made here). The header is read from the HTTP request and
// from the WebSocket upgrade request in the same way.
const TEAM = 'acme.cloudflareaccess.com';
const AUD = 'c'.repeat(64);
const HOST = 'dispatch.example.com';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' } as Jwk;
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
function assertion(claims: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64({ aud: [AUD], iss: `https://${TEAM}`, exp: now + 300, nbf: now - 5, email: 'owner@example.com', ...claims })}`;
  return `${data}.${createSign('RSA-SHA256').update(data).sign(privateKey).toString('base64url')}`;
}

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-gate-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function build() {
  const config = createAccessConfig(dir);
  const gate = createAccessGate({
    getToken: createTokenSource(dir), isGatewayPeer: () => false, config,
    tailscale: { self: async () => null, isOwnerPeer: async () => false },
    basePath: '',
    cfAccess: (c) => createCfAccessVerifier({ ...c, fetchJwks: async () => ({ keys: [JWK] }), log: () => {} }),
  });
  const app = express();
  // cloudflared connects from loopback.
  app.use((req, _res, next) => { Object.defineProperty(req.socket, 'remoteAddress', { value: '127.0.0.1', configurable: true }); next(); });
  app.use(gate.middleware);
  app.get('/api/x', (_req, res) => { res.json({ ok: true }); });
  app.get('/page', (_req, res) => { res.send('app'); });
  const viaTunnel = (p: string) => request(app).get(p).set('Host', HOST).set('X-Forwarded-For', '203.0.113.9').set('Cf-Connecting-Ip', '203.0.113.9');
  const upgrade = (headers: Record<string, string>) => gate.upgradeDecision({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: HOST, 'x-forwarded-for': '203.0.113.9', upgrade: 'websocket', ...headers },
  } as never, '/api/events');
  return { config, viaTunnel, upgrade };
}

describe('Cloudflare Access check through the HTTP gate', () => {
  test('check off: the allow-listed host passes with no assertion, as before', async () => {
    const { config, viaTunnel, upgrade } = build();
    config.addHost(HOST);
    expect((await viaTunnel('/api/x')).status).toBe(200);
    expect((await viaTunnel('/page')).text).toBe('app');
    expect((await upgrade({})).ok).toBe(true);
  });

  test('check on, no assertion: the page is the sign-in page and the API answers 401, never 403', async () => {
    const { config, viaTunnel, upgrade } = build();
    config.addHost(HOST);
    config.setCloudflareAccess({ teamDomain: TEAM, aud: AUD });
    const page = await viaTunnel('/page').set('Accept', 'text/html');
    expect(page.status).toBe(401);
    expect(page.text).toContain('id="t"');
    const api = await viaTunnel('/api/x');
    expect(api.status).toBe(401);
    expect(api.body).toEqual({ error: 'auth_required' });
    expect(await upgrade({})).toMatchObject({ ok: false, status: 401 });
  });

  test('check on, valid assertion: HTTP and the WebSocket upgrade pass', async () => {
    const { config, viaTunnel, upgrade } = build();
    config.addHost(HOST);
    config.setCloudflareAccess({ teamDomain: TEAM, aud: AUD });
    expect((await viaTunnel('/api/x').set('Cf-Access-Jwt-Assertion', assertion())).status).toBe(200);
    expect((await viaTunnel('/page').set('Cf-Access-Jwt-Assertion', assertion())).text).toBe('app');
    expect(await upgrade({ 'cf-access-jwt-assertion': assertion() })).toMatchObject({ ok: true, via: 'local' });
  });

  test('check on, an assertion for another application or an expired one: sign-in', async () => {
    const { config, viaTunnel, upgrade } = build();
    config.addHost(HOST);
    config.setCloudflareAccess({ teamDomain: TEAM, aud: AUD });
    expect((await viaTunnel('/api/x').set('Cf-Access-Jwt-Assertion', assertion({ aud: ['d'.repeat(64)] }))).status).toBe(401);
    expect((await viaTunnel('/api/x').set('Cf-Access-Jwt-Assertion', assertion({ exp: Math.floor(Date.now() / 1000) - 3600 }))).status).toBe(401);
    expect((await viaTunnel('/api/x').set('Cf-Access-Jwt-Assertion', 'junk')).status).toBe(401);
    expect(await upgrade({ 'cf-access-jwt-assertion': 'junk' })).toMatchObject({ ok: false, status: 401 });
  });

  test('turning the check off again needs no restart', async () => {
    const { config, viaTunnel } = build();
    config.addHost(HOST);
    config.setCloudflareAccess({ teamDomain: TEAM, aud: AUD });
    expect((await viaTunnel('/api/x')).status).toBe(401);
    config.setCloudflareAccess(null);
    expect((await viaTunnel('/api/x')).status).toBe(200);
  });
});
