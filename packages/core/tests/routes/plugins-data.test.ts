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
import { createPluginsRouter } from '../../src/routes/plugins.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { DOC_MAX_BYTES } from '../../src/db/plugin-data.js';
import { KeysManager } from './keys-manager.js';

/** Plugin storage and settings routes (docs/superpowers/specs/2026-11-07-plugins-design.md, section 5). */
describe('plugin storage routes (2026-11-07)', () => {
  let app: any;
  let db: Database.Database;
  let tmp: string;
  const plugin = (id: string, permissions: string[]) => {
    const dir = path.join(tmp, 'plugins', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', permissions }));
  };
  const asPlugin = (id: string) => ({ Authorization: `Bearer ${fs.readFileSync(path.join(tmp, 'keys', `plugin-${id}`), 'utf8').trim()}` });
  const asThread = () => ({ Authorization: `Bearer ${app.locals.keys.mint({ kind: 'thread', terminalId: 'tA' }).key}` });
  const put = (auth: Record<string, string>, id: string, key: string, value: unknown) =>
    request(app).put(`/api/plugins/${id}/data/${key}`).set(auth).set('Content-Type', 'application/json').send(JSON.stringify({ value }));

  beforeEach(() => {
    configureRefusalLog({ log: () => {} });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-data-'));
    db = new Database(':memory:');
    initSchema(db);
    plugin('open', ['threads:read-storage', 'threads:write-storage']);
    plugin('closed', []);
    const mgr = new KeysManager();
    app = createApp({ db, skipPty: true, pluginsDir: path.join(tmp, 'plugins'), secretsDir: tmp, managers: new Map([['claude-code', mgr.asManager()]]) });
    sessionsDb.create(db, { id: 'A', provider: 'claude-code', name: 'Alpha', workingDir: tmp });
    terminalsDb.create(db, { id: 'tA', sessionId: 'A', type: 'claude-code', label: 'Worker A', config: { transport: 'structured', role: 'agent' } });
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('the owner lists, writes, reads and deletes a document; unknown ids and keys are 404', async () => {
    expect((await request(app).get('/api/plugins/open/data')).body).toEqual({ docs: [] });
    const w = await put({}, 'open', 'pins', { ids: ['a'] });
    expect(w.status).toBe(200);
    expect(w.body).toMatchObject({ key: 'pins', value: { ids: ['a'] }, writer: null });
    expect((await request(app).get('/api/plugins/open/data/pins')).body.value).toEqual({ ids: ['a'] });
    expect((await request(app).get('/api/plugins/open/data')).body.docs.map((d: any) => d.key)).toEqual(['pins']);
    await request(app).get('/api/plugins/open/data/nope').expect(404);
    await request(app).get('/api/plugins/nope/data').expect(404);
    await request(app).delete('/api/plugins/open/data/pins').expect(204);
    await request(app).delete('/api/plugins/open/data/pins').expect(404);
    await put({}, 'open', 'bad key', 1).expect(400);
  });

  it('a plugin key reaches its own storage only', async () => {
    expect((await put(asPlugin('closed'), 'closed', 'k', 1)).status).toBe(200);
    expect((await request(app).get('/api/plugins/closed/data/k').set(asPlugin('closed'))).body.value).toBe(1);
    const other = await request(app).get('/api/plugins/closed/data/k').set(asPlugin('open'));
    expect(other.status).toBe(403);
    expect(other.body.message).toBe('A plugin reaches its own storage only.');
    expect((await put(asPlugin('open'), 'closed', 'k', 2)).status).toBe(403);
  });

  it('a thread reads only plugins that granted it, and its write carries the writer from the key', async () => {
    await put({}, 'open', 'shared', 'hello');
    await put({}, 'closed', 'secret', 'nope');
    const ok = await request(app).get('/api/plugins/open/data/shared').set(asThread());
    expect(ok.status).toBe(200);
    expect(ok.body.value).toBe('hello');
    const no = await request(app).get('/api/plugins/closed/data/secret').set(asThread());
    expect(no.status).toBe(403);
    expect(no.body.message).toBe('The plugin "closed" does not let threads read its storage.');
    const w = await request(app).put('/api/plugins/open/data/from-thread').set(asThread()).set('Content-Type', 'application/json')
      .send(JSON.stringify({ value: { n: 1 }, writer: { terminalId: 'forged', sessionId: 'B', label: 'Forged' } }));
    expect(w.status).toBe(200);
    expect(w.body.writer).toEqual({ terminalId: 'tA', sessionId: 'A', label: 'Worker A' });
    expect(w.body.value).toEqual({ n: 1 });
    const wno = await put(asThread(), 'closed', 'x', 1);
    expect(wno.status).toBe(403);
    expect(wno.body.message).toBe('The plugin "closed" does not let threads write its storage.');
  });

  it("a thread key cannot reach a disabled plugin's storage, nor a broken one's", async () => {
    await put({}, 'open', 'k', 'v');
    await request(app).post('/api/plugins/open/disable').expect(200);
    expect((await request(app).get('/api/plugins/open/data/k').set(asThread())).status).toBe(404);
    expect((await request(app).get('/api/plugins/open/data').set(asThread())).status).toBe(404);
    expect((await put(asThread(), 'open', 'k', 'changed')).status).toBe(404);
    expect((await request(app).delete('/api/plugins/open/data/k').set(asThread())).status).toBe(404);
    // the owner still can
    expect((await request(app).get('/api/plugins/open/data/k')).body.value).toBe('v');
  });

  it('a document over the size cap is refused with 413 and the old value stays', async () => {
    await put({}, 'open', 'big', 'small');
    const r = await put({}, 'open', 'big', 'x'.repeat(DOC_MAX_BYTES));
    expect(r.status).toBe(413);
    expect(r.body.error).toBe('too_large');
    expect((await request(app).get('/api/plugins/open/data/big')).body.value).toBe('small');
  });

  it('settings round-trip for the owner and the plugin; a thread key gets 403', async () => {
    expect((await request(app).get('/api/plugins/open/settings')).body).toEqual({ value: null, updatedAt: null });
    const r = await request(app).put('/api/plugins/open/settings').set('Content-Type', 'application/json').send(JSON.stringify({ value: { hours: 24 } }));
    expect(r.status).toBe(200);
    expect(r.body.value).toEqual({ hours: 24 });
    expect((await request(app).get('/api/plugins/open/settings').set(asPlugin('open'))).body.value).toEqual({ hours: 24 });
    expect((await request(app).put('/api/plugins/open/settings').set(asPlugin('open')).set('Content-Type', 'application/json').send('{"value":{"hours":48}}')).body.value).toEqual({ hours: 48 });
    expect((await request(app).get('/api/plugins/open/settings').set(asThread())).status).toBe(403);
    expect((await request(app).get('/api/plugins/open/settings').set(asPlugin('closed'))).status).toBe(403);
  });

  it("remove clears the plugin's data and settings", async () => {
    await put({}, 'open', 'k', 1);
    await request(app).put('/api/plugins/open/settings').set('Content-Type', 'application/json').send('{"value":{"a":1}}');
    await request(app).delete('/api/plugins/open').expect(204);
    plugin('open', []);
    expect((await request(app).get('/api/plugins/open/data')).body.docs).toEqual([]);
    expect((await request(app).get('/api/plugins/open/settings')).body.value).toBeNull();
  });

  describe('events (the router alone, with a recording broadcaster)', () => {
    it('a write and a delete broadcast plugin:data', async () => {
      const events: Record<string, unknown>[] = [];
      const registry = new PluginRegistry(path.join(tmp, 'plugins'), { broadcast: (e) => { events.push(e); } }, '3.28.0', { keys: app.locals.keys, keyDir: path.join(tmp, 'keys') });
      const bare = express();
      bare.use(express.json());
      bare.use('/api', createPluginsRouter(registry, db));
      await request(bare).put('/api/plugins/open/data/k').set('Content-Type', 'application/json').send('{"value":1}').expect(200);
      await request(bare).delete('/api/plugins/open/data/k').expect(204);
      expect(events.filter((e) => e.type === 'plugin:data')).toEqual([
        { type: 'plugin:data', id: 'open', key: 'k' },
        { type: 'plugin:data', id: 'open', key: 'k', deleted: true },
      ]);
    });
  });
});
