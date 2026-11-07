import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import express from 'express';
import { initSchema } from '../../src/db/schema.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as sessionsDb from '../../src/db/sessions.js';
import { createApp } from '../../src/server.js';
import { configureRefusalLog } from '../../src/auth/route-policy.js';
import { HTML_SANDBOX_CSP } from '../../src/routes/previews.js';
import { createPluginsRouter } from '../../src/routes/plugins.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { KeysManager } from './keys-manager.js';

describe('plugin routes', () => {
  let app: any;
  let db: Database.Database;
  let tmp: string;
  let dir: string;
  const asThread = () => ({ Authorization: `Bearer ${app.locals.keys.mint({ kind: 'thread', terminalId: 'tA' }).key}` });
  const asPlugin = (id: string) => ({ Authorization: `Bearer ${fs.readFileSync(path.join(tmp, 'keys', `plugin-${id}`), 'utf8').trim()}` });
  const plugin = (id: string, files: Record<string, string> = {}) => {
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    fs.writeFileSync(path.join(dir, id, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', web: 'web.js' }));
    fs.writeFileSync(path.join(dir, id, 'web.js'), 'export default () => {}');
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, id, name), body);
  };

  beforeEach(() => {
    configureRefusalLog({ log: () => {} });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-routes-'));
    dir = path.join(tmp, 'plugins');
    fs.writeFileSync(path.join(tmp, 'secret'), 'nope');
    db = new Database(':memory:');
    initSchema(db);
    const mgr = new KeysManager();
    app = createApp({ db, skipPty: true, pluginsDir: dir, secretsDir: tmp, managers: new Map([['claude-code', mgr.asManager()]]) });
    sessionsDb.create(db, { id: 'A', provider: 'claude-code', name: 'Alpha', workingDir: tmp });
    terminalsDb.create(db, { id: 'tA', sessionId: 'A', type: 'claude-code', label: 'Worker A', config: { transport: 'structured', role: 'agent' } });
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('GET /api/plugins lists rows for the owner and for a thread key', async () => {
    plugin('p');
    const owner = await request(app).get('/api/plugins');
    expect(owner.status).toBe(200);
    expect(owner.body.plugins.map((r: any) => r.id)).toEqual(['p']);
    expect(owner.headers['cache-control']).toBe('no-store');
    const thread = await request(app).get('/api/plugins').set(asThread());
    expect(thread.status).toBe(200);
    expect(thread.body.plugins).toHaveLength(1);
  });

  it("serves an enabled plugin file with no-cache; a disabled plugin's files are 404", async () => {
    plugin('p');
    const ok = await request(app).get('/plugins/p/web.js');
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toMatch(/javascript/);
    expect(ok.headers['cache-control']).toBe('no-cache');
    expect(ok.text).toContain('export default');
    await request(app).post('/api/plugins/p/disable').expect(200);
    await request(app).get('/plugins/p/web.js').expect(404);
    await request(app).get('/plugins/nope/web.js').expect(404);
    await request(app).get('/plugins/p/missing.js').expect(404);
  });

  it('an html file from a plugin carries the sandbox CSP', async () => {
    plugin('p', { 'page.html': '<script>alert(1)</script>' });
    const r = await request(app).get('/plugins/p/page.html');
    expect(r.status).toBe(200);
    expect(r.headers['content-security-policy']).toBe(HTML_SANDBOX_CSP);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it('a path that escapes the folder is 404 (encoded dot segments reach the handler; a client normalises plain ones away)', async () => {
    plugin('p');
    // A URL client folds `%2e%2e/` into a plain `..` segment and resolves it before the request
    // leaves, so only encoded-slash forms reach the handler; the registry test covers the rest.
    await request(app).get('/plugins/p/..%2f..%2fsecret').expect(404);
    await request(app).get('/plugins/p/%2e%2e%2f%2e%2e%2fsecret').expect(404);
    await request(app).get('/plugins/p/sub%2f..%2f..%2f..%2fsecret').expect(404);
  });

  it('scaffold, enable, disable, reload and remove are owner-only; a thread key gets 403', async () => {
    plugin('p');
    for (const [method, url] of [['post', '/api/plugins/scaffold'], ['post', '/api/plugins/p/enable'], ['post', '/api/plugins/p/disable'], ['post', '/api/plugins/p/reload'], ['delete', '/api/plugins/p']] as const) {
      const r = await (request(app) as any)[method](url).set(asThread()).send({ id: 'new-one', name: 'New' });
      expect(r.status, `${method} ${url}`).toBe(403);
    }
  });

  it('POST /api/plugins/scaffold creates the folder and returns the row; a second call is 409; a bad id is 400', async () => {
    const r = await request(app).post('/api/plugins/scaffold').send({ id: 'my-plugin', name: 'My plugin' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ id: 'my-plugin', name: 'My plugin', version: '0.1.0', enabled: true });
    expect(fs.existsSync(path.join(dir, 'my-plugin', 'web.js'))).toBe(true);
    await request(app).post('/api/plugins/scaffold').send({ id: 'my-plugin', name: 'Again' }).expect(409);
    await request(app).post('/api/plugins/scaffold').send({ id: 'Bad Id', name: 'x' }).expect(400);
    await request(app).post('/api/plugins/scaffold').send({ id: 'ok-id' }).expect(400);
  });

  it('enable and disable return the row; an unknown id is 404; remove deletes a local plugin', async () => {
    plugin('p');
    expect((await request(app).post('/api/plugins/p/disable')).body.enabled).toBe(false);
    expect((await request(app).post('/api/plugins/p/enable')).body.enabled).toBe(true);
    await request(app).post('/api/plugins/nope/enable').expect(404);
    await request(app).delete('/api/plugins/p').expect(204);
    expect(fs.existsSync(path.join(dir, 'p'))).toBe(false);
    await request(app).delete('/api/plugins/p').expect(404);
  });

  it('remove refuses an installed plugin with 400', async () => {
    plugin('shop', { '.dispatch-install.json': '{"marketplace":"m","version":"1","sha256":"x","installedAt":"t"}' });
    const r = await request(app).delete('/api/plugins/shop');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/not local/);
  });

  it("a plugin key lists plugins and calls whoami; a disabled plugin's key is 401 (2026-11-07)", async () => {
    plugin('p');
    await request(app).post('/api/plugins/p/enable').expect(200); // issues the key for a folder added after boot
    const list = await request(app).get('/api/plugins').set(asPlugin('p'));
    expect(list.status).toBe(200);
    expect(list.body.plugins[0].keyed).toBe(true);
    const who = await request(app).get('/api/whoami').set(asPlugin('p'));
    expect(who.body).toEqual({ kind: 'plugin', pluginId: 'p', permissions: [] });
    const auth = asPlugin('p');
    await request(app).post('/api/plugins/p/disable').expect(200);
    expect((await request(app).get('/api/plugins').set(auth)).status).toBe(401);
  });

  it('POST /api/plugins/:id/copy copies a bundled plugin to local; DELETE on a bundled one is 400', async () => {
    fs.mkdirSync(path.join(tmp, 'bundled', 'coach'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'bundled', 'coach', 'plugin.json'), JSON.stringify({ id: 'coach', name: 'Coach', version: '1.0.0' }));
    const mgr = new KeysManager();
    app = createApp({ db, skipPty: true, pluginsDir: dir, bundledDir: path.join(tmp, 'bundled'), secretsDir: tmp, managers: new Map([['claude-code', mgr.asManager()]]) });
    expect((await request(app).get('/api/plugins')).body.plugins.find((p: any) => p.id === 'coach').bundled).toBe(true);
    await request(app).delete('/api/plugins/coach').expect(400);
    const r = await request(app).post('/api/plugins/coach/copy').send({ id: 'my-coach' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ id: 'my-coach', name: 'Coach' });
    await request(app).post('/api/plugins/coach/copy').send({ id: 'my-coach' }).expect(409);
    await request(app).post('/api/plugins/coach/copy').send({ id: 'Bad' }).expect(400);
  });

  describe('events (the router alone, with a recording broadcaster)', () => {
    it('POST /api/plugins/:id/reload broadcasts plugin:changed', async () => {
      plugin('p');
      const events: Record<string, unknown>[] = [];
      const registry = new PluginRegistry(dir, { broadcast: (e) => { events.push(e); } }, '3.28.0', { keys: app.locals.keys, keyDir: path.join(tmp, 'keys') });
      const bare = express();
      bare.use(express.json());
      bare.use('/api', createPluginsRouter(registry));
      const r = await request(bare).post('/api/plugins/p/reload');
      expect(r.status).toBe(200);
      expect(events).toEqual([{ type: 'plugin:changed', id: 'p', plugin: expect.objectContaining({ id: 'p' }) }]);
    });
  });
});
