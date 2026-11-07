import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as sessionsDb from '../../src/db/sessions.js';
import { createApp } from '../../src/server.js';
import { configureRefusalLog } from '../../src/auth/route-policy.js';
import { PluginWorkers } from '../../src/plugins/workers.js';
import { KeysManager } from './keys-manager.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 4000): Promise<void> { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await sleep(20); } }

/** The worker proxy, logs and restart routes (plugins slice 5, Task 3). */
describe('plugin worker routes', () => {
  let app: any; let db: Database.Database; let tmp: string; let workers: PluginWorkers;
  // A worker that serves its socket: echoes what it got, and waits on /slow.
  const SCRIPT = `
    const http = require('http');
    console.log('worker up');
    http.createServer((req, res) => {
      let body = ''; req.on('data', (c) => body += c);
      req.on('end', () => {
        if (req.url.startsWith('/slow')) { setTimeout(() => { res.end('late'); }, 3000); return; }
        if (req.url.startsWith('/status')) { res.statusCode = 418; res.setHeader('x-tea', 'pot'); res.end('short'); return; }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ method: req.method, url: req.url, body, principal: req.headers['x-dispatch-principal'] || null, session: req.headers['x-dispatch-session'] || null, auth: req.headers.authorization || null, cookie: req.headers.cookie || null, host: req.headers.host || null }));
      });
    }).listen(process.env.DISPATCH_PLUGIN_SOCKET);
    process.on('SIGTERM', () => process.exit(0));
  `;
  const plugin = (id: string, permissions: string[], withWorker = true) => {
    fs.mkdirSync(path.join(tmp, 'plugins', id), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'plugins', id, 'worker.js'), SCRIPT);
    fs.writeFileSync(path.join(tmp, 'plugins', id, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', permissions, ...(withWorker ? { worker: { command: process.execPath, args: ['worker.js'] } } : {}) }));
  };
  const asPlugin = (id: string) => ({ Authorization: `Bearer ${fs.readFileSync(path.join(tmp, 'keys', `plugin-${id}`), 'utf8').trim()}` });
  const asThread = () => ({ Authorization: `Bearer ${app.locals.keys.mint({ kind: 'thread', terminalId: 'tA' }).key}` });

  beforeEach(async () => {
    configureRefusalLog({ log: () => {} });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-worker-'));
    db = new Database(':memory:'); initSchema(db);
    plugin('open', ['threads:call-worker']);
    plugin('closed', []);
    plugin('noworker', [], false);
    const mgr = new KeysManager();
    app = createApp({ db, skipPty: true, pluginsDir: path.join(tmp, 'plugins'), secretsDir: tmp, managers: new Map([['claude-code', mgr.asManager()]]) });
    sessionsDb.create(db, { id: 'A', provider: 'claude-code', name: 'Alpha', workingDir: tmp });
    terminalsDb.create(db, { id: 'tA', sessionId: 'A', type: 'claude-code', label: 'Worker A', config: { transport: 'structured', role: 'agent' } });
    workers = new PluginWorkers(app.locals.plugins, app.locals.threadEvents, { logDir: path.join(tmp, 'logs'), runDir: path.join(tmp, 'run'), api: 'http://127.0.0.1:1', backoffMs: () => 10, tickMs: null });
    app.locals.plugins.setWorkerStatsProvider((id: string) => workers.stats(id));
    app.locals.plugins.setWorkerSync(() => workers.sync());
    app.locals.pluginWorkers = workers;
    workers.sync();
    await until(() => !!workers.stats('open')?.socket && !!workers.stats('closed')?.socket);
  });
  afterEach(async () => { await workers.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it("the owner's request reaches the worker with method, path, query and body, and comes back with its status and headers; the caller's credentials are not forwarded", async () => {
    const r = await request(app).post('/api/plugins/open/worker/jobs/run?x=1').set('Cookie', 'dispatch=secret').set('Content-Type', 'application/json').send({ a: 1 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ method: 'POST', url: '/jobs/run?x=1', body: '{"a":1}', principal: 'owner', session: null, auth: null, cookie: null });
    const s = await request(app).get('/api/plugins/open/worker/status');
    expect(s.status).toBe(418);
    expect(s.headers['x-tea']).toBe('pot');
    expect(s.text).toBe('short');
    const root = await request(app).get('/api/plugins/open/worker/');
    expect(root.body.url).toBe('/');
  });

  it('a thread key gets 403 without threads:call-worker and thread:<id> with it; the plugin\'s own key is plugin:<id>; another plugin\'s key is refused', async () => {
    const no = await request(app).get('/api/plugins/closed/worker/ping').set(asThread());
    expect(no.status).toBe(403);
    expect(no.body.message).toMatch(/does not let threads call its worker/);
    const yes = await request(app).get('/api/plugins/open/worker/ping').set(asThread());
    expect(yes.status).toBe(200);
    expect(yes.body).toMatchObject({ principal: 'thread:tA', session: 'A', auth: null });
    const own = await request(app).get('/api/plugins/open/worker/ping').set(asPlugin('open'));
    expect(own.body).toMatchObject({ principal: 'plugin:open' });
    expect((await request(app).get('/api/plugins/open/worker/ping').set(asPlugin('closed'))).status).toBe(403);
  });

  it('the path reaches the worker as the caller encoded it', async () => {
    const r = await request(app).get('/api/plugins/open/worker/files/a%20b/c%2Fd?q=x%20y');
    expect(r.status).toBe(200);
    expect(r.body.url).toBe('/files/a%20b/c%2Fd?q=x%20y');
    expect((await request(app).get('/api/plugins/open/worker')).body.url).toBe('/');
  });

  it('no worker: 502 no_worker; an unknown plugin is 404', async () => {
    const r = await request(app).get('/api/plugins/noworker/worker/ping');
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('no_worker');
    expect((await request(app).get('/api/plugins/nope/worker/ping')).status).toBe(404);
  });

  it('disable mid-request answers the client', async () => {
    const pending = request(app).get('/api/plugins/open/worker/slow').then((r) => r);
    await sleep(100);
    await request(app).post('/api/plugins/open/disable').set('Origin', 'http://127.0.0.1:3456');
    const r = await pending;
    expect([502, 200]).toContain(r.status);
    await until(() => workers.stats('open')?.state === 'stopped');
  });

  it('logs returns the tail for the owner only; restart restarts the worker', async () => {
    await until(() => workers.logTail('open', 50).includes('worker up'));
    const r = await request(app).get('/api/plugins/open/logs?lines=5');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/plain/);
    expect(r.text).toContain('worker up');
    expect((await request(app).get('/api/plugins/open/logs').set(asThread())).status).toBe(403);
    expect((await request(app).get('/api/plugins/open/logs').set(asPlugin('open'))).status).toBe(403);
    const pid = workers.stats('open')!.pid!;
    expect((await request(app).post('/api/plugins/open/worker/restart').set('Origin', 'http://127.0.0.1:3456')).status).toBe(200);
    await until(() => workers.stats('open')?.state === 'running' && workers.stats('open')!.pid !== pid);
    expect(workers.stats('open')!.restarts).toBe(0);
    expect((await request(app).post('/api/plugins/open/worker/restart').set(asThread())).status).toBe(403);
  });
});
