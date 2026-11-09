// W2-H: GET /api/bootstrap is the launch calls in one answer. Each part comes from its own route, called
// inside the daemon as the same caller, so the part can never hold more than that route gives the caller.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { createApp } from '../server.js';
import { GATE_VIA } from '../auth/access-gate.js';
import { createPrincipalMiddleware } from '../auth/request-principal.js';
import { createKeyScope } from '../auth/key-scope.js';
import { KeyRegistry } from '../auth/principals.js';
import { configureRefusalLog, keyRoute, ownerOnlyStrict, policyKindOf, policyRouter } from '../auth/route-policy.js';
import { jsonCompression } from '../http/compress.js';
import { BOOTSTRAP_PARTS, createBootstrapRouter } from './bootstrap.js';

// One server for each app, bound to 127.0.0.1. supertest's own server listens on every address, and on this
// computer another program that holds the same port number on 127.0.0.1 then answers now and then.
const servers = new Map<unknown, http.Server>();
function on(app: unknown): http.Server {
  let s = servers.get(app);
  if (!s) { s = http.createServer(app as http.RequestListener).listen(0, '127.0.0.1'); servers.set(app, s); }
  return s;
}
afterEach(() => { for (const s of servers.values()) s.close(); servers.clear(); });

const TOKEN = 'owner-access-token-for-the-test-0123456789';
const SUMMARY = { type: 'usage-limits', at: 1, epoch: 'e1', rev: 7, warnPercent: 80, providers: [], paused: [] };

/** The path of the route behind each part (terminalsByProject has one path for each project). */
const ROUTE_OF: Record<string, string> = {
  sessions: '/api/sessions',
  stalls: '/api/terminals/stalls',
  authRequests: '/api/auth-requests',
  update: '/api/state/update',
  usageSummary: '/api/usage-limits/summary',
  schedules: '/api/agents/schedules',
};

describe('GET /api/bootstrap on the full app (W2-H)', () => {
  let app: any;
  let db: Database.Database;
  let tmp: string;
  const threadKey = () => ({ Authorization: `Bearer ${app.locals.keys.mint({ kind: 'thread', terminalId: 'tA1' }).key}` });

  beforeEach(() => {
    configureRefusalLog({ log: () => {} });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-'));
    const dir = path.join(tmp, 'plugins', 'demo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'demo', name: 'Demo', version: '1.0.0', permissions: [] }));
    db = new Database(':memory:');
    initSchema(db);
    app = createApp({
      db, skipPty: true, pluginsDir: path.join(tmp, 'plugins'), bundledDir: null, secretsDir: tmp,
      usageLimits: { snapshots: {} as never, accountFor: () => 'a', summary: () => SUMMARY as never },
    });
    app.locals.stallWatchdog = { all: () => [{ terminalId: 'tA1', stalledSince: 1_700_000_000_000 }] };
    for (const p of ['A', 'B', 'C']) {
      sessionsDb.create(db, { id: p, provider: 'claude-code', name: `Project ${p}`, workingDir: tmp });
      for (const n of [1, 2]) {
        terminalsDb.create(db, { id: `t${p}${n}`, sessionId: p, type: 'claude-code', label: `Thread ${p}${n} ${'x'.repeat(200)}`, config: { transport: 'structured', note: 'dtk_' + 'a'.repeat(43) } });
      }
    }
    app.locals.authRequestService?.create?.({ url: 'https://example.com/login', source: 'test' });
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('lists the parts of the plan', () => {
    expect([...BOOTSTRAP_PARTS].sort()).toEqual(['authRequests', 'plugins', 'schedules', 'sessions', 'sharedSettings', 'stalls', 'terminalsByProject', 'update', 'usageSummary']);
  });

  it('each part equals its own route', async () => {
    const boot = await request(on(app)).get('/api/bootstrap');
    expect(boot.status).toBe(200);
    expect(Object.keys(boot.body).sort()).toEqual([...BOOTSTRAP_PARTS].sort());
    for (const [part, route] of Object.entries(ROUTE_OF)) {
      const own = await request(on(app)).get(route);
      expect(own.status, route).toBe(200);
      expect(boot.body[part], part).toEqual(own.body);
    }
    expect(boot.body.sessions.map((s: { id: string }) => s.id).sort()).toEqual(['A', 'B', 'C']);
    expect(Object.keys(boot.body.terminalsByProject).sort()).toEqual(['A', 'B', 'C']);
    for (const p of ['A', 'B', 'C']) {
      const own = await request(on(app)).get(`/api/sessions/${p}/terminals`);
      expect(boot.body.terminalsByProject[p]).toEqual(own.body);
      expect(own.body).toHaveLength(2);
    }
    expect(boot.body.sharedSettings).toEqual({
      dictation: (await request(on(app)).get('/api/settings/dictation')).body,
      coordinator: (await request(on(app)).get('/api/settings/coordinator')).body,
    });
    expect(boot.body.stalls).toEqual([{ terminalId: 'tA1', stalledSince: 1_700_000_000_000 }]);
    expect(boot.body.usageSummary).toEqual(SUMMARY);
  });

  it('the plugin list is null: its route marks the answer no-store, and such an answer is not put in a compressed body', async () => {
    const own = await request(on(app)).get('/api/plugins');
    expect(own.headers['cache-control']).toMatch(/no-store/);
    expect(own.body.plugins.map((p: { id: string }) => p.id)).toEqual(['demo']);
    const boot = await request(on(app)).get('/api/bootstrap');
    expect(boot.body.plugins).toBeNull();
    expect(boot.text).not.toContain('"demo"');
  });

  it('the redaction of the terminals route stays: a key written in a thread config does not come out', async () => {
    const boot = await request(on(app)).get('/api/bootstrap');
    expect(JSON.stringify(boot.body)).not.toContain('dtk_' + 'a'.repeat(43));
  });

  it('a thread key gets 403', async () => {
    const res = await request(on(app)).get('/api/bootstrap').set(threadKey());
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('owner_only');
    expect(JSON.stringify(res.body)).not.toContain('Project A');
  });

  // One test for each part: a key never gets the part through the bootstrap, alone or with the others.
  for (const part of ['sessions', 'terminalsByProject', 'stalls', 'authRequests', 'update', 'usageSummary', 'sharedSettings', 'plugins', 'schedules']) {
    it(`part ${part}: a thread key gets 403 and no data when it asks for that part alone`, async () => {
      const res = await request(on(app)).get(`/api/bootstrap?parts=${part}`).set(threadKey());
      expect(res.status).toBe(403);
      expect(Object.keys(res.body).sort()).toEqual(['error', 'message']);
    });
    it(`part ${part}: ?parts= gives that part alone, equal to the full answer`, async () => {
      const full = await request(on(app)).get('/api/bootstrap');
      const one = await request(on(app)).get(`/api/bootstrap?parts=${part}`);
      expect(one.status).toBe(200);
      expect(Object.keys(one.body)).toEqual([part]);
      expect(one.body[part]).toEqual(full.body[part]);
    });
  }

  it('a plugin key and a Chat key get 403', async () => {
    const chat = app.locals.keys.mint({ kind: 'chat', startedBy: 'user' }).key;
    expect((await request(on(app)).get('/api/bootstrap').set('Authorization', `Bearer ${chat}`)).status).toBe(403);
    const pluginKey = fs.readFileSync(path.join(tmp, 'keys', 'plugin-demo'), 'utf8').trim();
    expect((await request(on(app)).get('/api/bootstrap').set('Authorization', `Bearer ${pluginKey}`)).status).toBe(403);
  });

  it('an unknown key gets 401 before the route runs', async () => {
    const res = await request(on(app)).get('/api/bootstrap').set('Authorization', 'Bearer dtk_' + 'z'.repeat(43));
    expect(res.status).toBe(401);
  });

  it('a body over 1 KB is compressed', async () => {
    const res = await request(on(app)).get('/api/bootstrap').set('Accept-Encoding', 'br');
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('br');
    expect(res.headers.vary).toMatch(/Accept-Encoding/i);
    const gz = await request(on(app)).get('/api/bootstrap').set('Accept-Encoding', 'gzip');
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gz.body.sessions).toHaveLength(3); // supertest reads gzip
  });

  it('an unknown name in ?parts= is ignored', async () => {
    const res = await request(on(app)).get('/api/bootstrap?parts=stalls,nope,__proto__');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['stalls']);
  });

  it('a route that is not mounted gives null for its part, not an error', async () => {
    const bare = createApp({ db, skipPty: true, pluginsDir: path.join(tmp, 'plugins'), bundledDir: null, secretsDir: tmp });
    expect((await request(on(bare)).get('/api/usage-limits/summary')).status).toBe(404);
    const res = await request(on(bare)).get('/api/bootstrap');
    expect(res.status).toBe(200);
    expect(res.body.usageSummary).toBeNull();
    expect(res.body.sessions).toHaveLength(3);
  });

  it('carries the owner policy tag', () => {
    const layer = (createBootstrapRouter(app) as unknown as { stack: { route?: { stack: { handle: unknown }[] } }[] }).stack.find((l) => l.route);
    expect(policyKindOf(layer!.route!.stack[0].handle)).toBe('owner');
  });
});

/**
 * The rule that makes the bootstrap safe: a part is read through its own route, as the same caller.
 * These routes stand for the kinds of rule a real route can have. `local` and `tailscale` are callers
 * with no credential (the gate let them in by address).
 */
describe('GET /api/bootstrap applies the rule of each route to the caller (W2-H)', () => {
  function appWith(via: 'local' | 'tailscale') {
    const db = new Database(':memory:'); initSchema(db);
    sessionsDb.create(db, { id: 'A', provider: 'claude-code', name: 'Alpha', workingDir: '/tmp' });
    terminalsDb.create(db, { id: 'tA', sessionId: 'A', type: 'claude-code', label: 'Worker', config: {} });
    const reg = new KeyRegistry();
    const app = express();
    const seen: string[] = [];
    app.use((req, _res, next) => { (req as any)[GATE_VIA] = via; next(); });
    app.use(createPrincipalMiddleware({ registry: reg, scope: createKeyScope(db), getToken: () => TOKEN, via: 'test' }));
    app.use(jsonCompression());
    const r = policyRouter();
    // A plain owner route, a route that needs the web page or a credential, a route that a key may read
    // in a smaller form, a route that marks its answer as a secret, and a route that fails.
    r.get('/sessions', (_q, s) => s.json([{ id: 'A', name: 'Alpha' }]));
    r.get('/sessions/:id/terminals', ownerOnlyStrict, (q, s) => { seen.push(String(q.headers['accept-encoding'] ?? '')); s.json([{ id: 'tA', secret: 'strict-only' }]); });
    r.get('/terminals/stalls', keyRoute({ thread: () => ({ ok: true }) }), (_q, s) => s.json([{ terminalId: 'tA', stalledSince: 5 }]));
    r.get('/auth-requests', (_q, s) => { s.setHeader('Cache-Control', 'no-store'); s.json([{ id: 'r1', pad: 'x'.repeat(2000) }]); });
    r.get('/state/update', () => { throw new Error('boom'); });
    r.get('/plugins', (_q, s) => s.json({ plugins: [{ id: 'p1' }] }));
    r.get('/agents/schedules', async (_q, s) => { await new Promise((d) => setTimeout(d, 5)); s.json([{ id: 's1' }]); });
    app.use('/api', r);
    app.use('/api/bootstrap', createBootstrapRouter(app));
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    app.use((err: Error, _q: express.Request, s: express.Response, _n: express.NextFunction) => { s.status(500).json({ error: 'internal' }); });
    return { app, reg, seen };
  }
  beforeEach(() => configureRefusalLog({ log: () => {} }));

  for (const via of ['local', 'tailscale'] as const) {
    it(`via ${via}: a caller with no credential that is not the web page gets no part that its route refuses`, async () => {
      const { app } = appWith(via);
      expect((await request(on(app)).get('/api/sessions/A/terminals')).status).toBe(401);
      const res = await request(on(app)).get('/api/bootstrap');
      expect(res.status).toBe(200);
      expect(res.body.sessions).toEqual([{ id: 'A', name: 'Alpha' }]);
      expect(res.body.terminalsByProject).toEqual({});
      expect(res.text).not.toContain('strict-only');
      expect(res.body.stalls).toEqual([{ terminalId: 'tA', stalledSince: 5 }]);
    });

    it(`via ${via}: the web page and the owner token get that part, as its route gives it`, async () => {
      const { app } = appWith(via);
      const page = await request(on(app)).get('/api/bootstrap').set('Sec-Fetch-Site', 'same-origin');
      expect(page.body.terminalsByProject).toEqual({ A: [{ id: 'tA', secret: 'strict-only' }] });
      const owner = await request(on(app)).get('/api/bootstrap').set('Authorization', `Bearer ${TOKEN}`);
      expect(owner.body.terminalsByProject).toEqual({ A: [{ id: 'tA', secret: 'strict-only' }] });
    });

    it(`via ${via}: a thread key gets 403, also where a part's own route would let the key in`, async () => {
      const { app, reg } = appWith(via);
      const key = reg.mint({ kind: 'thread', terminalId: 'tA' }).key;
      expect((await request(on(app)).get('/api/terminals/stalls').set('Authorization', `Bearer ${key}`)).status).toBe(200);
      const res = await request(on(app)).get('/api/bootstrap?parts=stalls').set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(403);
      expect(res.text).not.toContain('stalledSince');
    });
  }

  it('a route that fails or that is absent gives null; the other parts still come', async () => {
    const { app } = appWith('local');
    const res = await request(on(app)).get('/api/bootstrap').set('Sec-Fetch-Site', 'same-origin');
    expect(res.status).toBe(200);
    expect(res.body.update).toBeNull();          // the route threw
    expect(res.body.usageSummary).toBeNull();    // no such route
    expect(res.body.plugins).toEqual({ plugins: [{ id: 'p1' }] }); // a plugin list that is not no-store is a part
    expect(res.body.sharedSettings).toEqual({ dictation: null, coordinator: null });
    expect(res.body.schedules).toEqual([{ id: 's1' }]); // an async route is awaited
  });

  it('a part that its route marks no-store is null, and the answer stays compressed', async () => {
    const { app } = appWith('local');
    expect((await request(on(app)).get('/api/auth-requests')).headers['cache-control']).toMatch(/no-store/);
    const res = await request(on(app)).get('/api/bootstrap').set('Accept-Encoding', 'gzip').set('Sec-Fetch-Site', 'same-origin');
    expect(res.body.authRequests).toBeNull();
    expect(res.text).not.toContain('xxxxxxxx');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['content-encoding']).toBeUndefined(); // this small answer is under 1 KB
    const big = appWith('local');
    big.app.get('/api/usage-limits/summary', (_q, s) => s.json({ pad: 'y'.repeat(3000) }));
    const res2 = await request(on(big.app)).get('/api/bootstrap').set('Accept-Encoding', 'gzip').set('Sec-Fetch-Site', 'same-origin');
    expect(res2.headers['content-encoding']).toBe('gzip');
    expect(res2.body.authRequests).toBeNull();
    expect(res2.body.usageSummary.pad).toHaveLength(3000);
  });

  it('the inner calls ask for no encoding and carry no conditional header', async () => {
    const { app, seen } = appWith('local');
    await request(on(app)).get('/api/bootstrap').set('Sec-Fetch-Site', 'same-origin').set('Accept-Encoding', 'gzip').set('If-None-Match', 'W/"abc"');
    expect(seen).toEqual(['']);
  });
});
