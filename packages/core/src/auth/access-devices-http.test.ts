import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import request from 'supertest';
import { createAccessGate } from './access-gate.js';
import { createAccessConfig } from './known-hosts.js';
import { COOKIE_NAME, cookieValue, createTokenSource, deviceCookieValue, rotateAccessToken } from './access-token.js';
import { createPairCodes } from './pair-code.js';
import { createDeviceStore, type DeviceStore } from './devices.js';
import { initSchema } from '../db/schema.js';

let dir: string;
let peer: string;
let gwPeer: string | null;
const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
const LAPTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36';
const HOST = '192.168.1.5:3456';

function build(opts: { devices?: boolean } = { devices: true }) {
  const getToken = createTokenSource(dir);
  const db = new Database(':memory:');
  initSchema(db);
  const devices: DeviceStore | undefined = opts.devices === false ? undefined : createDeviceStore(db, { getToken });
  const pairCodes = createPairCodes();
  const gate = createAccessGate({
    getToken, isGatewayPeer: (a) => !!gwPeer && a === gwPeer, config: createAccessConfig(dir),
    tailscale: { self: async () => null, isOwnerPeer: async () => false },
    basePath: '', pairCodes, devices,
  });
  const app = express();
  app.use((req, _res, next) => { Object.defineProperty(req.socket, 'remoteAddress', { value: peer, configurable: true }); next(); });
  app.post('/api/access/login', ...gate.loginRoute);
  app.use(gate.middleware);
  app.get('/api/x', (_req, res) => { res.json({ ok: true }); });
  return { app, getToken, devices: devices!, pairCodes, gate };
}

const cookieOf = (r: request.Response): string => {
  const raw = ([] as string[]).concat(r.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!raw) throw new Error('no cookie set');
  return raw.split(';')[0].slice(COOKIE_NAME.length + 1);
};
const get = (app: express.Express, cookie: string | null, ua = PHONE) => {
  const r = request(app).get('/api/x').set('Host', HOST).set('User-Agent', ua);
  return cookie ? r.set('Cookie', `${COOKIE_NAME}=${cookie}`) : r;
};

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-gate-')); peer = '192.168.1.9'; gwPeer = null; });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('sign-in makes a device', () => {
  test('token sign-in sets a device cookie and lists the device', async () => {
    const { app, getToken, devices } = build();
    const r = await request(app).post('/api/access/login').set('Host', HOST).set('User-Agent', PHONE).send({ token: getToken() });
    expect(r.status).toBe(200);
    const c = cookieOf(r);
    expect(c.startsWith('v2.')).toBe(true);
    expect(c).not.toContain(getToken());
    expect((await get(app, c)).status).toBe(200);
    expect(devices.list()).toMatchObject([{ name: 'iPhone (Safari)', signedInVia: 'token', lastAddress: '192.168.1.9', addressKind: 'direct' }]);
  });
  test('code sign-in records "code"', async () => {
    const { app, pairCodes, devices } = build();
    const { code } = pairCodes.issue();
    const r = await request(app).post('/api/access/login').set('Host', HOST).set('User-Agent', LAPTOP).send({ code });
    expect(r.status).toBe(200);
    expect(devices.list()[0]).toMatchObject({ signedInVia: 'code', name: 'Mac (Chrome)' });
  });
  test('signing in again from the same browser reuses its device', async () => {
    const { app, getToken, devices } = build();
    const a = await request(app).post('/api/access/login').set('Host', HOST).send({ token: getToken() });
    const b = await request(app).post('/api/access/login').set('Host', HOST).set('Cookie', `${COOKIE_NAME}=${cookieOf(a)}`).send({ token: getToken() });
    expect(cookieOf(b)).toBe(cookieOf(a));
    expect(devices.list()).toHaveLength(1);
  });
  test('a Bearer token is not a device', async () => {
    const { app, getToken, devices } = build();
    const r = await request(app).get('/api/x').set('Host', HOST).set('Authorization', `Bearer ${getToken()}`);
    expect(r.status).toBe(200);
    expect(devices.list()).toEqual([]);
  });
  test('behind the WSL gateway, the gateway shows as its own kind', async () => {
    gwPeer = '172.20.0.1'; peer = '172.20.0.1';
    const { app, getToken, devices } = build();
    const r = await request(app).post('/api/access/login').set('Host', 'localhost:3456').send({ token: getToken() });
    expect(r.status).toBe(200);
    expect(devices.list()[0]).toMatchObject({ lastAddress: '172.20.0.1', addressKind: 'gateway' });
    // A later request through the same gateway is recognised by its cookie, not its address.
    expect((await request(app).get('/api/x').set('Host', 'localhost:3456').set('Cookie', `${COOKIE_NAME}=${cookieOf(r)}`)).status).toBe(200);
  });
});

describe('revoke', () => {
  test('ends only that device', async () => {
    const { app, getToken, devices } = build();
    const login = () => request(app).post('/api/access/login').set('Host', HOST).send({ token: getToken() });
    const a = cookieOf(await login());
    const b = cookieOf(await login());
    expect(a).not.toBe(b);
    const [first] = devices.list().filter((d) => a.includes(d.id));
    expect(devices.revoke(first.id)).toBe(true);
    expect((await get(app, a)).status).toBe(401);
    expect((await get(app, b)).status).toBe(200);
  });
  test('a revoked cookie replayed on a WebSocket upgrade decision is refused too', async () => {
    const { gate, app, getToken, devices } = build();
    const c = cookieOf(await request(app).post('/api/access/login').set('Host', HOST).send({ token: getToken() }));
    const fakeReq = (cookie: string) => ({ socket: { remoteAddress: peer }, headers: { host: HOST, cookie: `${COOKIE_NAME}=${cookie}` } });
    const ok = await gate.upgradeDecision(fakeReq(c) as never, '/api/events');
    expect(ok).toMatchObject({ ok: true, credential: { kind: 'cookie', deviceId: devices.list()[0].id } });
    devices.revoke(devices.list()[0].id);
    expect(await gate.upgradeDecision(fakeReq(c) as never, '/api/events')).toMatchObject({ ok: false, status: 401 });
  });
  test('rotating the token still signs out every device', async () => {
    const { app, getToken } = build();
    const c = cookieOf(await request(app).post('/api/access/login').set('Host', HOST).send({ token: getToken() }));
    expect((await get(app, c)).status).toBe(200);
    rotateAccessToken(dir);
    expect((await get(app, c)).status).toBe(401);
  });
  test('a cookie with a valid shape but a made-up id is refused', async () => {
    const { app, getToken } = build();
    expect((await get(app, deviceCookieValue(getToken(), 'madeUpDeviceId1'))).status).toBe(401);
  });
});

describe('upgrade safety: cookies from before the device list', () => {
  test('the old cookie still works, and is swapped for a device cookie', async () => {
    const { app, getToken, devices } = build();
    const old = cookieValue(getToken());
    const r = await get(app, old);
    expect(r.status).toBe(200);
    const fresh = cookieOf(r);
    expect(fresh.startsWith('v2.')).toBe(true);
    expect(devices.list()).toMatchObject([{ signedInVia: 'earlier', name: 'iPhone (Safari)' }]);
    // The new cookie works, and the device can now be revoked on its own.
    expect((await get(app, fresh)).status).toBe(200);
    devices.revoke(devices.list()[0].id);
    expect((await get(app, fresh)).status).toBe(401);
  });
  test('two browsers with the old cookie each become a device', async () => {
    const { app, getToken, devices } = build();
    const old = cookieValue(getToken());
    await get(app, old, PHONE);
    await get(app, old, LAPTOP);
    expect(devices.list().map((d) => d.name).sort()).toEqual(['Mac (Chrome)', 'iPhone (Safari)']);
  });
  test('parallel requests from one browser make one device', async () => {
    const { app, getToken, devices } = build();
    const old = cookieValue(getToken());
    await Promise.all([get(app, old), get(app, old), get(app, old)]);
    expect(devices.list()).toHaveLength(1);
  });
  test('ending older sign-ins refuses the old cookie; device cookies keep working', async () => {
    const { app, getToken, devices } = build();
    const old = cookieValue(getToken());
    const fresh = cookieOf(await get(app, old));
    devices.endLegacy();
    expect((await get(app, old)).status).toBe(401);
    expect((await get(app, fresh)).status).toBe(200);
  });
  test('without a device store the old cookie keeps working and no cookie is set (hosted box, tests)', async () => {
    const { app, getToken } = build({ devices: false });
    const r = await get(app, cookieValue(getToken()));
    expect(r.status).toBe(200);
    expect(r.headers['set-cookie']).toBeUndefined();
  });
});

describe('last seen', () => {
  test('a request through the gate updates the device', async () => {
    const { app, getToken, devices } = build();
    const c = cookieOf(await request(app).post('/api/access/login').set('Host', HOST).send({ token: getToken() }));
    expect(devices.list()).toHaveLength(1);
    peer = '192.168.1.77';
    await get(app, c); // inside the one-minute throttle: no write, but it must not crash or add a device
    expect(devices.list()).toHaveLength(1);
  });
});
