// W3-A: the behaviours that Waves 1 and 2 put into startServer, proved through the production wiring.
// Each test builds the daemon with buildDaemon (the same call as startServer) and uses HTTP or a WebSocket.
import { afterEach, describe, expect, test, vi } from 'vitest';
import request from 'supertest';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import * as appState from '../db/app-state.js';
import { createTokenSource } from '../auth/access-token.js';
import { createAccessConfig } from '../auth/known-hosts.js';
import { createCfAccessVerifier, type Jwk } from '../auth/cf-access.js';
import { configureRefusalLog } from '../auth/route-policy.js';
import { createDaemonHttpServer } from './http-server.js';
import { closeKits, kit, type Kit } from '../../tests/daemon/kit.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); closeKits(); });
configureRefusalLog({ log: () => {} });

const LAN_HOST = '192.168.1.5:3456';
const lan = (k: Kit) => { k.peer.address = '192.168.1.9'; };
function seedThread(k: Kit, id = 't1', status = 'waiting') {
  if (!sessionsDb.getById(k.db, 'p1')) sessionsDb.create(k.db, { id: 'p1', provider: 'claude-code', name: 'Project', workingDir: k.dir });
  terminalsDb.create(k.db, { id, sessionId: 'p1', type: 'claude-code', label: 'Thread', config: { transport: 'structured' } });
  if (status !== 'waiting') k.db.prepare('UPDATE terminals SET status = ? WHERE id = ?').run(status, id);
}

describe('the order of the request gate (auth: gate)', () => {
  test('the sign-in route is before the gate: a remote device signs in with the token and then reads the API', async () => {
    const k = kit({ auth: 'gate' });
    lan(k);
    const server = await k.server();
    const token = createTokenSource(k.dir)();
    expect((await request(server).post('/api/access/login').set('Host', LAN_HOST).send({ token: 'wrong' })).status).toBe(401);
    const login = await request(server).post('/api/access/login').set('Host', LAN_HOST).send({ token });
    expect(login.status).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    expect((await request(server).get('/api/sessions').set('Host', LAN_HOST).set('Cookie', cookie)).status).toBe(200);
    // The signed-in device is in the device list (the device store is wired to the gate and to the routes).
    const devices = await request(server).get('/api/access/devices').set('Host', LAN_HOST).set('Cookie', cookie);
    expect(devices.status).toBe(200);
    expect(devices.body.devices).toHaveLength(1);
    expect(devices.body.devices[0].current).toBe(true);
  });

  test('a thread key cannot sign in, and an unknown key gets 401 (the key check is before the sign-in route)', async () => {
    const k = kit({ auth: 'gate' });
    lan(k);
    const server = await k.server();
    const key = k.daemon.services.keys.mint({ kind: 'thread', terminalId: 't1' }).key;
    const r = await request(server).post('/api/access/login').set('Host', LAN_HOST).set('Authorization', `Bearer ${key}`).send({ token: createTokenSource(k.dir)() });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('owner_only');
    const unknown = await request(server).post('/api/access/login').set('Host', LAN_HOST).set('Authorization', `Bearer dtk_${'z'.repeat(43)}`).send({});
    expect(unknown.status).toBe(401);
  });

  test('the gate is before the body parser: a remote caller with no credential gets 401 for a broken body, not 400', async () => {
    const k = kit({ auth: 'gate' });
    lan(k);
    const r = await request(await k.server()).post('/api/sessions').set('Host', LAN_HOST).set('Content-Type', 'application/json').send('{bad');
    expect(r.status).toBe(401);
    k.peer.address = '127.0.0.1';
    const local = await request(await k.server()).post('/api/sessions').set('Host', 'localhost:3456').set('Content-Type', 'application/json').send('{bad');
    expect(local.status).toBe(400);
    expect(local.text).not.toContain('node_modules'); // the JSON error handler is last
  });

  test('the principal check is after the gate: a thread key on this computer is a thread, not the owner', async () => {
    const k = kit({ auth: 'gate' });
    seedThread(k);
    const server = await k.server();
    const key = k.daemon.services.keys.mint({ kind: 'thread', terminalId: 't1' }).key;
    const who = await request(server).get('/api/whoami').set('Host', 'localhost:3456').set('Authorization', `Bearer ${key}`);
    expect(who.body).toMatchObject({ kind: 'thread', terminalId: 't1' });
    expect((await request(server).get('/api/outbox').set('Host', 'localhost:3456').set('Authorization', `Bearer ${key}`)).status).toBe(403);
    // With no credential the caller is the local program or page: `none`, which the owner routes admit.
    expect((await request(server).get('/api/whoami').set('Host', 'localhost:3456')).body).toMatchObject({ kind: 'none' });
    expect((await request(server).get('/api/outbox').set('Host', 'localhost:3456')).status).toBe(200);
  });

  test('pair codes are wired to the route and to the sign-in route', async () => {
    const k = kit({ auth: 'gate' });
    const server = await k.server();
    const code = await request(server).post('/api/access/pair-code').set('Host', 'localhost:3456').set('Origin', 'http://localhost:3456').set('Sec-Fetch-Site', 'same-origin');
    expect(code.status).toBe(200);
    expect(typeof code.body.code).toBe('string');
    lan(k);
    const login = await request(server).post('/api/access/login').set('Host', LAN_HOST).send({ code: code.body.code });
    expect(login.status).toBe(200);
  });

  test('auth open has no sign-in route and no pair codes, as createApp always had', async () => {
    const k = kit({ auth: 'open' });
    const server = await k.server();
    expect((await request(server).post('/api/access/login').send({ token: 'x' })).status).toBe(404);
    expect((await request(server).post('/api/access/pair-code')).status).toBe(404);
    expect(k.daemon.services.accessGate).toBeUndefined();
  });
});

describe('Cloudflare Access through the build (W1-C)', () => {
  const TEAM = 'acme.cloudflareaccess.com';
  const AUD = 'c'.repeat(64);
  const HOST = 'dispatch.example.com';
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' } as Jwk;
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const assertion = (claims: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const data = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64({ aud: [AUD], iss: `https://${TEAM}`, exp: now + 300, nbf: now - 5, email: 'owner@example.com', ...claims })}`;
    return `${data}.${createSign('RSA-SHA256').update(data).sign(privateKey).toString('base64url')}`;
  };

  test('an allow-listed host needs a valid assertion when the check is on; HTTP and the WebSocket upgrade agree', async () => {
    const k = kit({ auth: 'gate', cfAccess: (c) => createCfAccessVerifier({ ...c, fetchJwks: async () => ({ keys: [JWK] }), log: () => {} }) });
    const server = await k.server();
    const config = createAccessConfig(k.dir); // the same access.json that the build reads
    config.addHost(HOST);
    const viaTunnel = (p: string) => request(server).get(p).set('Host', HOST).set('X-Forwarded-For', '203.0.113.9').set('Cf-Connecting-Ip', '203.0.113.9');
    expect((await viaTunnel('/api/sessions')).status).toBe(200); // check off: as before
    config.setCloudflareAccess({ teamDomain: TEAM, aud: AUD });
    expect((await viaTunnel('/api/sessions')).status).toBe(401);
    expect((await viaTunnel('/api/sessions').set('Cf-Access-Jwt-Assertion', 'junk')).status).toBe(401);
    expect((await viaTunnel('/api/sessions').set('Cf-Access-Jwt-Assertion', assertion({ aud: ['d'.repeat(64)] }))).status).toBe(401);
    expect((await viaTunnel('/api/sessions').set('Cf-Access-Jwt-Assertion', assertion())).status).toBe(200);

    const port = await k.port();
    const open = (headers: Record<string, string>) => new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events`, { headers: { Host: HOST, 'X-Forwarded-For': '203.0.113.9', Origin: `https://${HOST}`, ...headers } });
      ws.once('open', () => { ws.terminate(); resolve(101); });
      ws.once('unexpected-response', (_q, res) => { resolve(res.statusCode ?? 0); ws.terminate(); });
      ws.once('error', () => resolve(-1));
    });
    expect(await open({})).toBe(401);
    expect(await open({ 'Cf-Access-Jwt-Assertion': assertion() })).toBe(101);
  });
});

describe('compression (W1-E)', () => {
  test('API JSON over 1 KB goes out compressed, in both builds', async () => {
    for (const auth of ['open', 'gate'] as const) {
      const k = kit({ auth });
      seedThread(k);
      const r = await request(await k.server()).get('/api/bootstrap').set('Host', 'localhost:3456').set('Accept-Encoding', 'gzip');
      expect(r.status).toBe(200);
      expect(r.headers['content-encoding'], auth).toBe('gzip');
      expect(r.body.sessions).toHaveLength(1);
      const br = await request(await k.server()).get('/api/bootstrap').set('Host', 'localhost:3456').set('Accept-Encoding', 'br');
      expect(br.headers['content-encoding'], auth).toBe('br');
      // A small answer goes out as it is.
      expect((await request(await k.server()).get('/api/providers').set('Host', 'localhost:3456').set('Accept-Encoding', 'gzip')).headers['content-encoding']).toBeUndefined();
    }
  });

  test('the three sockets offer permessage-deflate (W1-E, W2-I)', async () => {
    const k = kit({ auth: 'gate' });
    const port = await k.port();
    const ext = (path: string) => new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { Origin: `http://127.0.0.1:${port}` } });
      ws.once('open', () => { resolve(ws.extensions); ws.terminate(); });
      ws.once('error', reject);
    });
    expect(await ext('/api/events')).toContain('permessage-deflate');
    seedThread(k);
    expect(await ext('/api/terminals/t1/structured-ws')).toContain('permessage-deflate');
    expect(await ext('/api/terminals/t1/ws')).toContain('permessage-deflate'); // only the scrollback replay is compressed (ws/client-wss.ts)
  });
});

describe('the sockets (attach)', () => {
  const connect = (port: number, path: string, headers: Record<string, string> = {}) => new Promise<{ ws?: WebSocket; status: number }>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    ws.once('open', () => resolve({ ws, status: 101 }));
    ws.once('unexpected-response', (_q, res) => { resolve({ status: res.statusCode ?? 0 }); ws.terminate(); });
    ws.once('error', () => resolve({ status: -1 }));
  });

  test('the events socket gets what the broadcaster sends, and answers the page ping', async () => {
    const k = kit({ auth: 'gate' });
    const port = await k.port();
    const { ws } = await connect(port, '/api/events');
    const frames: string[] = [];
    ws!.on('message', (d) => frames.push(d.toString()));
    k.daemon.services.broadcaster.broadcast({ type: 'session:tabs-changed', sessionId: 'p1' });
    ws!.send('ping');
    await expect.poll(() => frames.length).toBe(2);
    expect(frames.map((f) => JSON.parse(f))).toEqual(expect.arrayContaining([{ type: 'session:tabs-changed', sessionId: 'p1' }, { type: 'pong' }]));
    ws!.terminate();
  });

  test('a route that broadcasts reaches the events socket (the terminals router has the broadcaster)', async () => {
    const k = kit({ auth: 'gate' });
    const port = await k.port();
    const { ws } = await connect(port, '/api/events');
    const frames: { type: string }[] = [];
    ws!.on('message', (d) => frames.push(JSON.parse(d.toString())));
    const created = await request(await k.server()).post('/api/sessions').set('Host', 'localhost:3456').send({ name: 'P', workingDir: k.dir, provider: 'claude-code' });
    expect(created.status).toBeLessThan(300);
    await expect.poll(() => frames.map((f) => f.type)).toContain('session:created');
    ws!.terminate();
  });

  test('a remote Host with no credential is refused with 401; a thread key is refused with 403; a path that names no socket gets 404', async () => {
    const k = kit({ auth: 'gate' });
    const port = await k.port();
    expect((await connect(port, '/api/events', { Host: LAN_HOST })).status).toBe(401);
    const key = k.daemon.services.keys.mint({ kind: 'thread', terminalId: 't1' }).key;
    expect((await connect(port, '/api/events', { Authorization: `Bearer ${key}` })).status).toBe(403);
    expect((await connect(port, '/api/nothing')).status).toBe(404);
    // A caller the gate refuses learns nothing about which paths are sockets: the same 401 for both.
    expect((await connect(port, '/api/nothing', { Host: LAN_HOST })).status).toBe(401);
  });

  test('revoking a device closes its open sockets', async () => {
    const k = kit({ auth: 'gate' });
    lan(k);
    const server = await k.server();
    const login = await request(server).post('/api/access/login').set('Host', LAN_HOST).send({ token: createTokenSource(k.dir)() });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const { ws, status } = await connect(await k.port(), '/api/events', { Host: LAN_HOST, Cookie: cookie, Origin: `http://${LAN_HOST}` });
    expect(status).toBe(101);
    const closed = new Promise<void>((r) => ws!.once('close', () => r()));
    const list = await request(server).get('/api/access/devices').set('Host', LAN_HOST).set('Cookie', cookie);
    k.daemon.services.devices!.revoke(list.body.devices[0].id);
    await closed;
  });

  test('stop ends the connected sockets', async () => {
    const k = kit({ auth: 'gate' });
    const { ws } = await connect(await k.port(), '/api/events');
    const closed = new Promise<void>((r) => ws!.once('close', () => r()));
    k.daemon.stop();
    await closed;
  });

  test('the HTTP server of the daemon keeps an idle connection for 75 s (W2-H)', () => {
    const k = kit();
    const s = createDaemonHttpServer(k.daemon.app);
    expect(s.keepAliveTimeout).toBe(75_000);
    expect(s.headersTimeout).toBe(76_000);
  });
});

describe('the stall watchdog, the outbox, bootstrap and the usage refresh', () => {
  test('GET /api/terminals/stalls reads the watchdog of the build, and the 30 s tick runs it (W1-D)', async () => {
    let now = 1_700_000_000_000;
    const k = kit({ timers: true, clock: () => now });
    seedThread(k, 't1', 'working');
    const { stallWatchdog, agentService } = k.daemon.services;
    expect(k.daemon.app.locals.stallWatchdog).toBe(stallWatchdog);
    expect((await request(await k.server()).get('/api/terminals/stalls')).body).toEqual([]);
    const due = vi.spyOn(agentService, 'processDueRuns');
    vi.useFakeTimers();
    k.daemon.startTimers();
    // 11 minutes of 30 s ticks with no frame from the thread (one long jump would read as a sleep of the computer).
    for (let n = 0; n < 22; n++) { now += 30_000; vi.advanceTimersByTime(30_000); }
    expect(due).toHaveBeenCalledTimes(22);
    vi.useRealTimers();
    const stalls = await request(await k.server()).get('/api/terminals/stalls');
    expect(stalls.body).toHaveLength(1);
    expect(stalls.body[0]).toMatchObject({ terminalId: 't1' });
    const diag = await request(await k.server()).get('/api/terminals/t1/diagnostics');
    expect(diag.status).toBe(200);
    expect(diag.body.stall).not.toBeNull();
  });

  test('a failed scheduler run does not stop the stall check of the same tick', () => {
    const k = kit({ timers: true });
    const { stallWatchdog, agentService } = k.daemon.services;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(agentService, 'processDueRuns').mockImplementation(() => { throw new Error('boom'); });
    const tick = vi.spyOn(stallWatchdog, 'tick');
    vi.useFakeTimers();
    k.daemon.startTimers();
    vi.advanceTimersByTime(30_000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  test('GET /api/outbox lists the outbox of the build, and the diagnostics route reads it and the saved questions (W2-C, W2-G)', async () => {
    const k = kit();
    seedThread(k);
    const { outbox } = k.daemon.services;
    expect(k.daemon.app.locals.deliveryOutbox).toBe(outbox);
    expect(k.daemon.app.locals.pendingQuestions.get('t1')).toBeFalsy();
    // No process runs for t1: the notice waits in the outbox.
    outbox.enqueue({ kind: 'notice', targetId: 't1', body: 'A worker finished.', dedupKey: 'k1' });
    const list = await request(await k.server()).get('/api/outbox');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain('A worker finished.');
    // The diagnostics route lists the delivery (no body: the route never shows a message text).
    const diag = await request(await k.server()).get('/api/terminals/t1/diagnostics');
    expect(diag.body.deliveries).toHaveLength(1);
    expect(diag.body.deliveries[0]).toMatchObject({ kind: 'notice' });
  });

  test('GET /api/bootstrap gives every part, each from its own route (W2-H)', async () => {
    const k = kit();
    seedThread(k);
    const r = await request(await k.server()).get('/api/bootstrap');
    expect(r.status).toBe(200);
    expect(r.body.sessions).toHaveLength(1);
    expect(r.body.stalls).toEqual([]);
    // The usage routes are mounted in every build now: the part is the gauge's summary, not null.
    expect(r.body.usageSummary).toMatchObject({ type: 'usage-limits' });
  });

  test('POST /api/usage-limits/refresh reaches refreshNow of the gauge of the build (2026-11-09)', async () => {
    const k = kit({ auth: 'gate' });
    const refresh = vi.spyOn(k.daemon.services.usageGauge, 'refreshNow');
    const r = await request(await k.server()).post('/api/usage-limits/refresh').set('Host', 'localhost:3456').set('Origin', 'http://localhost:3456').set('Sec-Fetch-Site', 'same-origin');
    expect(r.status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test('app.locals holds every source that a route reads from it', () => {
    const k = kit();
    const l = k.daemon.app.locals;
    const s = k.daemon.services;
    expect(l.keys).toBe(s.keys);
    expect(l.plugins).toBe(s.plugins);
    expect(l.threadEvents).toBe(s.threadEvents);
    expect(l.marketplaces).toBe(s.marketplaces);
    expect(l.installer).toBe(s.installer);
    expect(l.skills).toBe(s.skills);
    expect(l.pluginWorkers).toBe(s.pluginWorkers);
    expect(l.stallWatchdog).toBe(s.stallWatchdog);
    expect(l.deliveryOutbox).toBe(s.outbox);
    expect(typeof l.pendingQuestions.get).toBe('function');
  });
});

describe('a thread through the build', () => {
  test('a message to a Pretty thread starts its process, and the settle reaches the status and the usage-limit service', async () => {
    const k = kit();
    seedThread(k);
    const server = await k.server();
    const sent = await request(server).post('/api/terminals/t1/message').send({ text: 'hello' });
    expect(sent.status).toBeLessThan(300);
    expect(k.manager.spawned.map((s) => s.id)).toEqual(['t1']);
    expect(k.manager.sent).toHaveLength(1);
    // The usage-limit wire, absent from createApp before W3-A: a stop from the CLI parks the thread.
    const park = vi.spyOn(k.daemon.services.usageLimits, 'park');
    k.manager.emit('usage-limit', 't1', { kind: 'usage', resetsAt: Date.now() + 3_600_000, message: 'You have hit your limit' });
    expect(park).toHaveBeenCalledWith('t1', 'claude-code', expect.anything());
    // The park reaches the status (markPaused) and the gauge (the change listener): two more wires of the same build.
    expect(terminalsDb.getById(k.db, 't1')!.status).toBe('scheduled');
    expect(k.daemon.services.usageGauge.summary().paused).toHaveLength(1);
  });

  test('listening(port) gives the threads the address of the daemon and saves the port', () => {
    const k = kit();
    const env = vi.spyOn(k.manager, 'setDefaultEnv');
    k.daemon.listening(4131);
    expect(appState.get(k.db, 'port')).toBe('4131');
    // The spawn env of every thread is built again with the address.
    expect((env.mock.calls.at(-1) as unknown as [Record<string, string>])[0].DISPATCH_API).toBe('http://127.0.0.1:4131');
    seedThread(k);
    k.daemon.services.sessionService.ensureStructuredAlive('t1');
    const mcp = fs.readFileSync(path.join(k.dir, 'thread-t1.mcp.json'), 'utf8');
    expect(mcp).toContain('"DISPATCH_API": "http://127.0.0.1:4131"');
    expect(mcp).toContain('"DISPATCH_PORT": "4131"');
  });

  test('the build starts no plugin worker; listening() starts them, with the address of the daemon', async () => {
    const plugins = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-workers-')), 'plugins');
    fs.mkdirSync(path.join(plugins, 'w'), { recursive: true });
    fs.writeFileSync(path.join(plugins, 'w', 'worker.js'), "require('fs').writeFileSync(process.argv[2], process.env.DISPATCH_API || 'none'); setInterval(() => {}, 1000); process.on('SIGTERM', () => process.exit(0));");
    const mark = path.join(plugins, 'started.txt');
    fs.writeFileSync(path.join(plugins, 'w', 'plugin.json'), JSON.stringify({ id: 'w', name: 'w', version: '1.0.0', permissions: [], worker: { command: process.execPath, args: ['worker.js', mark] } }));
    const k = kit({ pluginsDir: plugins });
    try {
      await new Promise((r) => setTimeout(r, 300));
      expect(fs.existsSync(mark)).toBe(false);
      k.daemon.listening(4131);
      await expect.poll(() => fs.existsSync(mark), { timeout: 5000 }).toBe(true);
      expect(fs.readFileSync(mark, 'utf8')).toBe('http://127.0.0.1:4131');
    } finally {
      await k.daemon.services.pluginWorkers.stop();
      fs.rmSync(path.dirname(plugins), { recursive: true, force: true });
    }
  });

  test('before listening, the spawn env names no daemon address: a test build never points a thread at a daemon', () => {
    const k = kit();
    const env = vi.spyOn(k.manager, 'setDefaultEnv');
    k.daemon.services.refreshSpawnEnv();
    const last = (env.mock.calls.at(-1) as unknown as [Record<string, string>])[0];
    expect(last.DISPATCH_API).toBeUndefined();
    expect(typeof last.PATH).toBe('string');
    seedThread(k);
    k.daemon.services.sessionService.ensureStructuredAlive('t1');
    expect(fs.readFileSync(path.join(k.dir, 'thread-t1.mcp.json'), 'utf8')).not.toContain('DISPATCH_API');
  });

  test('the build with a port tells the threads that address at once, as startServer does', () => {
    const k = kit({ port: 4131 });
    const env = vi.spyOn(k.manager, 'setDefaultEnv');
    k.daemon.services.refreshSpawnEnv();
    expect((env.mock.calls.at(-1) as unknown as [Record<string, string>])[0].DISPATCH_API).toBe('http://127.0.0.1:4131');
  });

  test('bootRecover closes the status of a working thread whose process is gone, and delivers what waited in the outbox', async () => {
    const k = kit();
    seedThread(k, 't1', 'working');
    // A CLI thread with no process: its wake waits in the outbox (W2-C).
    terminalsDb.create(k.db, { id: 't2', sessionId: 'p1', type: 'claude-code', label: 'CLI thread', config: {} });
    const { outbox, ptyManager } = k.daemon.services;
    expect(outbox.enqueue({ kind: 'watch', targetId: 't2', body: 'wake up', dedupKey: 'w1' }).state).toBe('pending');
    const write = vi.spyOn(ptyManager, 'write');
    (ptyManager as unknown as { spawn(id: string): number }).spawn('t2'); // the next life: the process of t2 runs again
    await k.daemon.bootRecover({ settleMs: 0 });
    expect(terminalsDb.getById(k.db, 't1')!.status).not.toBe('working');
    expect((outbox.list({ terminalId: 't2' }) as { state: string }[])[0].state).toBe('delivered');
    expect(write).toHaveBeenCalledTimes(1);
    // A second recovery delivers nothing again.
    await k.daemon.bootRecover({ settleMs: 0 });
    expect(write).toHaveBeenCalledTimes(1);
  });

  test('bootRecover after stop does nothing and does not throw', async () => {
    const k = kit();
    seedThread(k, 't1', 'working');
    const recovered = k.daemon.bootRecover({ settleMs: 20 });
    k.daemon.stop();
    k.db.close();
    await expect(recovered).resolves.toBeUndefined();
  });

  test('stop kills the processes of every manager and revokes the keys', () => {
    const k = kit();
    seedThread(k);
    k.daemon.services.sessionService.ensureStructuredAlive('t1');
    const key = k.manager.spawned[0].opts.env!.DISPATCH_AUTH; // the key that the build minted for the process
    expect(k.daemon.services.keys.resolve(key)).toMatchObject({ kind: 'thread', terminalId: 't1' });
    expect(k.manager.isAlive('t1')).toBe(true);
    k.daemon.stop();
    expect(k.manager.isAlive('t1')).toBe(false);
    expect(k.daemon.services.keys.resolve(key)).toBeFalsy();
  });
});
