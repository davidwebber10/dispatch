import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { WebSocket } from 'ws';

// A real daemon on a random port with its own HOME, driven over loopback and, where the
// machine has one, over its own LAN address (a connection to your own LAN IP arrives from
// that LAN IP, not from loopback, so it exercises the "other device" path).
const lanIp = Object.values(os.networkInterfaces()).flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))?.address;

let home: string;
let child: ChildProcess;
let port: number;
let output = '';
let token: string;
let projectDir: string;
let terminalId = 'none';
let threadKey = '';

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string }
function call(opts: { method?: string; path: string; host?: string; via?: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: opts.via ?? '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path,
      headers: { ...(opts.host ? { Host: opts.host } : {}), ...opts.headers },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function wsOutcome(url: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => { ws.terminate(); resolve('open'); });
    ws.once('unexpected-response', (_req, res) => { res.resume(); resolve(String(res.statusCode)); });
    ws.once('error', () => resolve('error'));
  });
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-ne-int-'));
  projectDir = path.join(home, 'proj');
  fs.mkdirSync(projectDir);
  port = 40000 + Math.floor(Math.random() * 20000);
  child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `globalThis.fetch = async () => { throw new Error('offline test'); }; const { startServer } = await import('./src/server.ts'); const s = await startServer({port:${port}}); console.log('MINTED_KEY=' + s.keys.mint({ kind: 'thread', terminalId: 'int-t1' }).key);`], {
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

const EVIL = { Origin: 'http://evil.example' };

describe('upgrade handling', () => {
  test('a peer that resets while the gate is deciding does not crash the daemon', async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((resolve) => {
        const sock = net.connect(port, '127.0.0.1', () => {
          sock.write(`GET /api/events HTTP/1.1\r\nHost: sy.example.ts.net\r\nTailscale-User-Login: a@b.c\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
          sock.resetAndDestroy();
          resolve();
        });
        sock.on('error', () => resolve());
      });
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(child.exitCode).toBeNull();
    expect((await call({ path: '/api/sessions' })).status).toBe(200);
  });
});

describe('per-thread keys, stage 1', () => {
  const bearer = () => ({ Authorization: `Bearer ${threadKey}` });
  test('whoami with a minted key returns the terminal id', async () => {
    const r = await call({ path: '/api/whoami', headers: bearer() });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ kind: 'thread', terminalId: 'int-t1' });
  });
  test('whoami with no credential from loopback is none', async () => {
    const r = await call({ path: '/api/whoami' });
    expect(JSON.parse(r.body)).toEqual({ kind: 'none' });
  });
  test('a WebSocket that carries a key is refused: terminal, structured, events', async () => {
    expect(await wsOutcome(`ws://127.0.0.1:${port}/api/events`, bearer())).toBe('403');
    expect(await wsOutcome(`ws://127.0.0.1:${port}/api/terminals/${terminalId}/ws`, bearer())).toBe('403');
    expect(await wsOutcome(`ws://127.0.0.1:${port}/api/terminals/${terminalId}/structured-ws`, bearer())).toBe('403');
  });
  test('a key-bearing login is refused and sets no cookie', async () => {
    const r = await call({ method: 'POST', path: '/api/access/login', headers: { ...bearer(), 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    expect(r.status).toBe(403);
    expect(r.headers['set-cookie']).toBeUndefined();
  });
  test('the stats route counts credential-free requests and refuses a key', async () => {
    await call({ path: '/api/sessions' });
    const r = await call({ path: '/api/access/no-credential-stats' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).program.total).toBeGreaterThan(0);
    expect((await call({ path: '/api/access/no-credential-stats', headers: bearer() })).status).toBe(403);
  });
  test('the key never appears in the daemon output', () => {
    expect(output.replace(/MINTED_KEY=\S+/, '')).not.toContain(threadKey);
  });
});

describe('this machine', () => {
  test('loopback with a loopback Host needs no credential', async () => {
    expect((await call({ path: '/api/sessions' })).status).toBe(200);
    expect((await call({ path: '/api/sessions', host: `localhost:${port}` })).status).toBe(200);
  });
  test('hooks and helpers that post to 127.0.0.1 with no token still work', async () => {
    const r = await call({ method: 'POST', path: '/api/events/claude/nope', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect([401, 403]).not.toContain(r.status);
  });
  test('every response carries the security headers', async () => {
    const r = await call({ path: '/api/sessions' });
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    const denied = await call({ path: '/api/sessions', host: 'evil.example' });
    expect(denied.headers['x-frame-options']).toBe('DENY');
  });
  test('data directory is private (SEC-18)', () => {
    const mode = (p: string) => fs.statSync(p).mode & 0o777;
    expect(mode(path.join(home, '.dispatch'))).toBe(0o700);
    expect(mode(path.join(home, '.dispatch', 'dispatch.db'))).toBe(0o600);
    expect(mode(path.join(home, '.dispatch', 'access-token'))).toBe(0o600);
  });
  test('startup prints the network line and never the token', () => {
    expect(output).toContain('dispatch access');
    expect(output).not.toContain(token);
  });
});

describe('web page and rebinding attacks from the owner browser', () => {
  test('DNS rebinding: a foreign Host is refused', async () => {
    const r = await call({ path: '/api/sessions', host: `evil.example:${port}` });
    expect(r.status).toBe(401);
  });
  test('foreign-Origin WebSockets are refused: events, terminal, structured', async () => {
    expect(await wsOutcome(`ws://127.0.0.1:${port}/api/events`, EVIL)).toBe('403');
    expect(await wsOutcome(`ws://127.0.0.1:${port}/api/terminals/${terminalId}/ws`, EVIL)).toBe('403');
    expect(await wsOutcome(`ws://127.0.0.1:${port}/api/terminals/${terminalId}/structured-ws`, EVIL)).toBe('403');
    expect(await wsOutcome(`ws://127.0.0.1:${port}/api/events`, { Origin: 'null' })).toBe('403');
  });
  test('the events WebSocket opens with no Origin, and with a same-origin Origin', async () => {
    expect(await wsOutcome(`ws://127.0.0.1:${port}/api/events`)).toBe('open');
    expect(await wsOutcome(`ws://127.0.0.1:${port}/api/events`, { Origin: `http://127.0.0.1:${port}` })).toBe('open');
  });
  test('SEC-03: cross-site mkdir, upload and delete are refused and change nothing', async () => {
    const target = path.join(home, 'made-by-evil');
    const mk = await call({ method: 'POST', path: `/api/state/mkdir?path=${encodeURIComponent(target)}`, headers: { ...EVIL, 'content-type': 'text/plain' } });
    expect(mk.status).toBe(403);
    expect(fs.existsSync(target)).toBe(false);

    const boundary = 'xBOUNDARYx';
    const multipart = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="planted.txt"\r\nContent-Type: text/plain\r\n\r\nhi\r\n--${boundary}--\r\n`;
    const up = await call({ method: 'POST', path: '/api/sessions/any/files/upload?path=.', headers: { ...EVIL, 'content-type': `multipart/form-data; boundary=${boundary}` }, body: multipart });
    expect(up.status).toBe(403);

    const del = await call({ method: 'DELETE', path: '/api/sessions/any/files?path=.', headers: EVIL });
    expect(del.status).toBe(403);
    expect(fs.existsSync(projectDir)).toBe(true);
  });
  test('cross-site no-cors GET of the API is refused by Sec-Fetch-Site', async () => {
    const r = await call({ path: '/api/sessions', headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect(r.status).toBe(403);
  });
});

describe.skipIf(!lanIp)('another device (own LAN address)', () => {
  const lan = () => ({ via: lanIp!, host: `${lanIp}:${port}` });
  test('API is 401 and the page is the sign-in page', async () => {
    expect((await call({ path: '/api/sessions', ...lan() })).status).toBe(401);
    const page = await call({ path: '/', ...lan() });
    expect(page.status).toBe(401);
    expect(page.body).toContain('Sign-in code or access token');
  });
  test('the WebSocket is refused with 401', async () => {
    expect(await wsOutcome(`ws://${lanIp}:${port}/api/events`)).toBe('401');
  });
  test('Host: localhost from the LAN does not help', async () => {
    expect((await call({ path: '/api/sessions', via: lanIp!, host: `localhost:${port}` })).status).toBe(401);
  });
  test('bearer token works; a wrong one does not', async () => {
    expect((await call({ path: '/api/sessions', ...lan(), headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await call({ path: '/api/sessions', ...lan(), headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
  });
  test('login sets a cookie that opens the API and the WebSocket; rotation signs it out', async () => {
    const login = await call({ method: 'POST', path: '/api/access/login', ...lan(), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    expect(login.status).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    expect((await call({ path: '/api/sessions', ...lan(), headers: { Cookie: cookie } })).status).toBe(200);
    expect(await wsOutcome(`ws://${lanIp}:${port}/api/events`, { Cookie: cookie })).toBe('open');
    // The cookie holder who visits an evil page is still refused.
    expect(await wsOutcome(`ws://${lanIp}:${port}/api/events`, { Cookie: cookie, ...EVIL })).toBe('403');

    // dispatch access rotate: a new token in the same file. The daemon notices by mtime.
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(path.join(home, '.dispatch', 'access-token'), 'rotated-token-value\n', { mode: 0o600 });
    expect((await call({ path: '/api/sessions', ...lan(), headers: { Cookie: cookie } })).status).toBe(401);
  });
});
