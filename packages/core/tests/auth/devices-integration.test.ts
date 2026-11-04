import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { cookieValue } from '../../src/auth/access-token.js';

// A real daemon with its own HOME. A connection to the machine's own LAN address arrives from that
// address, not loopback, so it is an "other device" that must sign in (same trick as access-integration).
const lanIp = Object.values(os.networkInterfaces()).flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))?.address;
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';

let home: string;
let child: ChildProcess;
let port: number;
let output = '';
let token: string;
let threadKey = '';

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string }
function call(opts: { method?: string; path: string; cookie?: string; headers?: Record<string, string>; body?: unknown; lan?: boolean }): Promise<Res> {
  const lan = opts.lan ?? true;
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request({
      host: lan ? lanIp : '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path,
      headers: {
        Host: `${lan ? lanIp : '127.0.0.1'}:${port}`, 'User-Agent': UA,
        ...(opts.cookie ? { Cookie: `dispatch_access=${opts.cookie}` } : {}),
        ...(payload ? { 'content-type': 'application/json' } : {}),
        ...opts.headers,
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const setCookie = (r: Res): string | null => {
  const raw = ([] as string[]).concat(r.headers['set-cookie'] ?? []).find((c) => c.startsWith('dispatch_access='));
  return raw ? raw.split(';')[0].slice('dispatch_access='.length) : null;
};
const signIn = async (): Promise<string> => {
  const r = await call({ method: 'POST', path: '/api/access/login', body: { token } });
  expect(r.status).toBe(200);
  return setCookie(r)!;
};
const list = async (cookie: string) => JSON.parse((await call({ path: '/api/access/devices', cookie })).body) as {
  devices: { id: string; name: string; signedInVia: string; current: boolean; lastAddress: string }[]; currentDeviceId: string | null; legacyOpen: boolean;
};

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-dev-int-'));
  port = 40000 + Math.floor(Math.random() * 20000);
  child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `globalThis.fetch = async () => { throw new Error('offline test'); }; const { startServer } = await import('./src/server.ts'); const s = await startServer({port:${port}}); console.log('MINTED_KEY=' + s.keys.mint({ kind: 'thread', terminalId: 'dev-t1' }).key);`], {
    cwd: path.resolve(import.meta.dirname, '..', '..'),
    env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH, SHELL: '/bin/sh', DISPATCH_TELEMETRY: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => { output += d; });
  child.stderr!.on('data', (d) => { output += d; });
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => { clearInterval(poll); reject(new Error(output)); }, 20000);
    const poll = setInterval(() => {
      if (/listening on port/.test(output) && /MINTED_KEY=\S+/.test(output)) { clearInterval(poll); clearTimeout(deadline); resolve(); }
    }, 25);
  });
  token = fs.readFileSync(path.join(home, '.dispatch', 'access-token'), 'utf8').trim();
  threadKey = /MINTED_KEY=(\S+)/.exec(output)![1];
}, 30000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    await exited;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!lanIp)('device list over the real daemon', () => {
  test('list shows this device and marks it', async () => {
    const a = await signIn();
    const l = await list(a);
    expect(l.devices.length).toBeGreaterThanOrEqual(1);
    expect(l.currentDeviceId).toBeTruthy();
    const me = l.devices.find((d) => d.current)!;
    expect(me).toMatchObject({ name: 'iPhone (Safari)', signedInVia: 'token', lastAddress: lanIp });
    expect(l.devices.filter((d) => d.current)).toHaveLength(1);
  });

  test('revoke ends only that device, from another device', async () => {
    const a = await signIn();
    const b = await signIn();
    const idB = (await list(b)).currentDeviceId!;
    const r = await call({ method: 'DELETE', path: `/api/access/devices/${idB}`, cookie: a });
    expect(r.status).toBe(200);
    expect(setCookie(r)).toBeNull(); // A revoked B: A keeps its own cookie
    expect((await call({ path: '/api/sessions', cookie: b })).status).toBe(401);
    expect((await call({ path: '/api/sessions', cookie: a })).status).toBe(200);
  });

  test('a device can revoke itself, and its cookie is cleared', async () => {
    const a = await signIn();
    const id = (await list(a)).currentDeviceId!;
    const r = await call({ method: 'DELETE', path: `/api/access/devices/${id}`, cookie: a });
    expect(r.status).toBe(200);
    expect(([] as string[]).concat(r.headers['set-cookie'] ?? []).join(';')).toMatch(/dispatch_access=;.*Max-Age=0/);
    expect((await call({ path: '/api/sessions', cookie: a })).status).toBe(401);
  });

  test('rename', async () => {
    const a = await signIn();
    const id = (await list(a)).currentDeviceId!;
    expect((await call({ method: 'PATCH', path: `/api/access/devices/${id}`, cookie: a, body: { name: 'Jason phone' } })).status).toBe(200);
    expect((await list(a)).devices.find((d) => d.id === id)!.name).toBe('Jason phone');
    expect((await call({ method: 'PATCH', path: `/api/access/devices/${id}`, cookie: a, body: { name: '  ' } })).status).toBe(400);
    expect((await call({ method: 'PATCH', path: '/api/access/devices/nope', cookie: a, body: { name: 'x' } })).status).toBe(404);
  });

  test('a thread key gets 403 on list, rename and revoke', async () => {
    const a = await signIn();
    const id = (await list(a)).currentDeviceId!;
    const k = { Authorization: `Bearer ${threadKey}` };
    expect((await call({ path: '/api/access/devices', headers: k, lan: false })).status).toBe(403);
    expect((await call({ method: 'PATCH', path: `/api/access/devices/${id}`, headers: k, lan: false, body: { name: 'x' } })).status).toBe(403);
    expect((await call({ method: 'DELETE', path: `/api/access/devices/${id}`, headers: k, lan: false })).status).toBe(403);
    expect((await call({ method: 'POST', path: '/api/access/devices/end-legacy', headers: k, lan: false })).status).toBe(403);
    expect((await call({ path: '/api/sessions', cookie: a })).status).toBe(200); // not revoked
  });

  test('the browser on this computer can list without a cookie and sees no "this device"', async () => {
    const r = await call({ path: '/api/access/devices', lan: false });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).currentDeviceId).toBeNull();
  });

  test('the old shared cookie keeps working after the upgrade and is swapped for a device cookie', async () => {
    const old = cookieValue(token);
    const r = await call({ path: '/api/access/devices', cookie: old });
    expect(r.status).toBe(200);
    const fresh = setCookie(r);
    expect(fresh?.startsWith('v2.')).toBe(true);
    const body = JSON.parse(r.body);
    expect(body.legacyOpen).toBe(true);
    expect(body.devices.find((d: { current: boolean }) => d.current)).toMatchObject({ signedInVia: 'earlier' });
    expect((await call({ path: '/api/sessions', cookie: fresh! })).status).toBe(200);
  });

  test('an open WebSocket closes when its device is revoked', async () => {
    const a = await signIn();
    const b = await signIn();
    const idA = (await list(a)).currentDeviceId!;
    const ws = new WebSocket(`ws://${lanIp}:${port}/api/events`, { headers: { Cookie: `dispatch_access=${a}`, Host: `${lanIp}:${port}` } });
    await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
    const closed = new Promise<void>((res) => ws.once('close', () => res()));
    expect((await call({ method: 'DELETE', path: `/api/access/devices/${idA}`, cookie: b })).status).toBe(200);
    await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error('socket stayed open')), 3000))]);
  });

  test('a socket opened with the shared cookie closes when the device later made from that cookie is revoked', async () => {
    const other = await signIn();
    const old = cookieValue(token);
    const ws = new WebSocket(`ws://${lanIp}:${port}/api/events`, { headers: { Cookie: `dispatch_access=${old}`, Host: `${lanIp}:${port}`, 'User-Agent': UA } });
    await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
    const closed = new Promise<void>((res) => ws.once('close', () => res()));
    // The same browser's next HTTP request adopts it into a device of its own.
    const r = await call({ path: '/api/access/devices', cookie: old });
    const mine = JSON.parse(r.body).currentDeviceId as string;
    expect(mine).toBeTruthy();
    expect((await call({ method: 'DELETE', path: `/api/access/devices/${mine}`, cookie: other })).status).toBe(200);
    await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error('legacy socket survived the revoke')), 3000))]);
  });

  test('a socket opened with the shared cookie just after its device was made is tied to that device', async () => {
    const other = await signIn();
    const old = cookieValue(token);
    const r = await call({ path: '/api/access/devices', cookie: old, headers: { 'User-Agent': 'late-browser/1.0 (Mac)' } });
    const mine = JSON.parse(r.body).currentDeviceId as string;
    const ws = new WebSocket(`ws://${lanIp}:${port}/api/events`, { headers: { Cookie: `dispatch_access=${old}`, Host: `${lanIp}:${port}`, 'User-Agent': 'late-browser/1.0 (Mac)' } });
    await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
    const closed = new Promise<void>((res) => ws.once('close', () => res()));
    expect((await call({ method: 'DELETE', path: `/api/access/devices/${mine}`, cookie: other })).status).toBe(200);
    await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error('late legacy socket survived the revoke')), 3000))]);
  });

  test('ending older sign-ins closes sockets that were opened with the shared cookie', async () => {
    const a = await signIn();
    const old = cookieValue(token);
    const ws = new WebSocket(`ws://${lanIp}:${port}/api/events`, { headers: { Cookie: `dispatch_access=${old}`, Host: `${lanIp}:${port}` } });
    await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
    const closed = new Promise<void>((res) => ws.once('close', () => res()));
    expect((await call({ method: 'POST', path: '/api/access/devices/end-legacy', cookie: a })).status).toBe(200);
    await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error('shared-cookie socket stayed open')), 3000))]);
  });

  test('ending older sign-ins turns the shared cookie off', async () => {
    const a = await signIn();
    const old = cookieValue(token);
    expect((await call({ method: 'POST', path: '/api/access/devices/end-legacy', cookie: a })).status).toBe(200);
    expect((await call({ path: '/api/sessions', cookie: old })).status).toBe(401);
    expect((await call({ path: '/api/sessions', cookie: a })).status).toBe(200);
    expect((await list(a)).legacyOpen).toBe(false);
  });

  test('the addresses a phone could use: owner gets lists of IPv4 strings, a thread key gets 403', async () => {
    const a = await signIn();
    const r = await call({ path: '/api/access/addresses', cookie: a });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as { tailscale: string[]; lan: string[] };
    expect(Array.isArray(body.tailscale)).toBe(true);
    expect(body.lan).toContain(lanIp); // the machine's own LAN address is offered
    for (const ip of [...body.tailscale, ...body.lan]) expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(r.headers['cache-control']).toContain('no-store');
    expect((await call({ path: '/api/access/addresses', headers: { Authorization: `Bearer ${threadKey}` }, lan: false })).status).toBe(403);
    expect((await call({ path: '/api/access/addresses', lan: false })).status).toBe(200); // the browser on this computer
  });

  test('no token or cookie value appears in the daemon output', () => {
    expect(output).not.toContain(token);
  });
});
