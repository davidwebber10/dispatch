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
import { makeMarket } from '../plugins/market-fixture.js';
import { KeysManager } from './keys-manager.js';

/** The marketplace and install routes (plugins slice 6, Task 3): owner-only. */
describe('marketplace routes', () => {
  let app: any; let db: Database.Database; let tmp: string; let m: ReturnType<typeof makeMarket>;
  const O = { Origin: 'http://127.0.0.1:3456' };
  const post = (route: string, body: unknown = {}) => request(app).post(route).set(O).set('Content-Type', 'application/json').send(JSON.stringify(body));
  const asPlugin = (id: string) => ({ Authorization: `Bearer ${fs.readFileSync(path.join(tmp, 'keys', `plugin-${id}`), 'utf8').trim()}` });
  const asThread = () => ({ Authorization: `Bearer ${app.locals.keys.mint({ kind: 'thread', terminalId: 'tA' }).key}` });

  beforeEach(() => {
    configureRefusalLog({ log: () => {} });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-routes-'));
    m = makeMarket();
    db = new Database(':memory:'); initSchema(db);
    fs.mkdirSync(path.join(tmp, 'plugins', 'local-one'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'plugins', 'local-one', 'plugin.json'), JSON.stringify({ id: 'local-one', name: 'Local', version: '1.0.0' }));
    const mgr = new KeysManager();
    app = createApp({ db, skipPty: true, pluginsDir: path.join(tmp, 'plugins'), secretsDir: tmp, managers: new Map([['claude-code', mgr.asManager()]]) });
    sessionsDb.create(db, { id: 'A', provider: 'claude-code', name: 'Alpha', workingDir: tmp });
    terminalsDb.create(db, { id: 'tA', sessionId: 'A', type: 'claude-code', label: 'Worker A', config: { transport: 'structured', role: 'agent' } });
  });
  afterEach(() => { m.rm(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('add, list, pull, trust and remove a marketplace; a bad URL is 400; a repository that is not there keeps git\'s line on the row', async () => {
    const added = await post('/api/plugins/marketplaces', { url: m.url });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ url: m.url, name: 'Test market', trusted: false, error: null });
    const slug = added.body.slug as string;
    expect((await request(app).get('/api/plugins/marketplaces')).body.marketplaces.map((x: any) => x.slug)).toEqual([slug]);
    expect((await post(`/api/plugins/marketplaces/${slug}/pull`)).body.error).toBeNull();
    expect((await post(`/api/plugins/marketplaces/${slug}/trusted`, { on: true })).body.trusted).toBe(true);
    const bad = await post('/api/plugins/marketplaces', { url: '--upload-pack=x' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/not a marketplace url/);
    const gone = await post('/api/plugins/marketplaces', { url: path.join(tmp, 'nowhere.git') });
    expect(gone.status).toBe(201);
    expect(gone.body.error).toMatch(/does not exist|not found|No such/i);
    expect((await request(app).delete(`/api/plugins/marketplaces/${slug}`).set(O)).status).toBe(204);
    expect((await request(app).delete(`/api/plugins/marketplaces/${slug}`).set(O)).status).toBe(404);
  });

  it('catalog, install, versions, updates, update, rollback, pin and auto-update through the routes', async () => {
    const slug = (await post('/api/plugins/marketplaces', { url: m.url })).body.slug as string;
    const cat = await request(app).get('/api/plugins/catalog');
    expect(cat.body.entries.map((e: any) => [e.kind, e.id, e.installed ?? null])).toEqual([['plugin', 'hello', null], ['skill', 'tidy', null]]);
    const inst = await post('/api/plugins/install', { marketplace: slug, id: 'hello' });
    expect(inst.status).toBe(201);
    expect(inst.body).toMatchObject({ id: 'hello', version: '1.0.0', enabled: true, install: { marketplace: m.url, version: '1.0.0' } });
    expect((await request(app).get('/api/plugins/catalog')).body.entries[0].installed).toEqual({ version: '1.0.0' });
    expect((await post('/api/plugins/install', { marketplace: slug, id: 'hello' })).status).toBe(409);
    expect((await post('/api/plugins/install', { marketplace: slug, id: 'local-one' })).status).toBe(409);
    expect((await post('/api/plugins/install', { marketplace: slug, id: 'nope' })).status).toBe(404);
    m.plugin('hello', '1.1.0'); m.commit('bump');
    expect((await request(app).get('/api/plugins/updates')).body.updates).toEqual([]);
    const checked = await post('/api/plugins/updates/check');
    expect(checked.body.updates).toEqual([expect.objectContaining({ id: 'hello', from: '1.0.0', to: '1.1.0' })]);
    expect((await request(app).get('/api/plugins')).body.plugins.find((p: any) => p.id === 'hello')).toMatchObject({ update: { to: '1.1.0' }, autoUpdate: false });
    expect((await request(app).get('/api/plugins/hello/versions')).body.versions.map((v: any) => v.version)).toEqual(['1.1.0', '1.0.0']);
    expect((await post('/api/plugins/hello/pin', { version: '1.0.0' })).body.pinned).toBe('1.0.0');
    expect((await request(app).get('/api/plugins/updates')).body.updates).toEqual([]);
    expect((await post('/api/plugins/hello/pin', { version: null })).body.pinned).toBeUndefined();
    const up = await post('/api/plugins/hello/update');
    expect(up.status).toBe(200);
    expect(up.body.version).toBe('1.1.0');
    const back = await post('/api/plugins/hello/rollback');
    expect(back.body.version).toBe('1.0.0');
    expect((await post('/api/plugins/hello/auto-update', { on: true })).body.autoUpdate).toBe(true);
    expect((await post('/api/plugins/local-one/update')).status).toBe(400);
    expect((await post('/api/plugins/local-one/rollback')).status).toBe(400);
  });

  it('a marketplace removed while a plugin installed from it stays: the row says marketplace gone and the plugin still serves', async () => {
    const slug = (await post('/api/plugins/marketplaces', { url: m.url })).body.slug as string;
    await post('/api/plugins/install', { marketplace: slug, id: 'hello' });
    await request(app).delete(`/api/plugins/marketplaces/${slug}`).set(O);
    const row = (await request(app).get('/api/plugins')).body.plugins.find((p: any) => p.id === 'hello');
    expect(row).toMatchObject({ enabled: true, marketplaceGone: true });
    expect((await request(app).get('/plugins/hello/web.js')).status).toBe(200);
    expect((await post('/api/plugins/hello/update')).status).toBe(409);
  });

  it('every marketplace and install route is owner-only', async () => {
    const slug = (await post('/api/plugins/marketplaces', { url: m.url })).body.slug as string;
    await post('/api/plugins/install', { marketplace: slug, id: 'hello' });
    for (const who of [asThread(), asPlugin('hello')]) {
      expect((await request(app).get('/api/plugins/marketplaces').set(who)).status).toBe(403);
      expect((await request(app).get('/api/plugins/catalog').set(who)).status).toBe(403);
      expect((await request(app).get('/api/plugins/updates').set(who)).status).toBe(403);
      expect((await request(app).post('/api/plugins/install').set(who).send({ marketplace: slug, id: 'hello' })).status).toBe(403);
      expect((await request(app).post('/api/plugins/hello/update').set(who)).status).toBe(403);
      expect((await request(app).post(`/api/plugins/marketplaces/${slug}/pull`).set(who)).status).toBe(403);
    }
  });
});
