import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as pluginData from '../../src/db/plugin-data.js';
import { createApp } from '../../src/server.js';
import { configureRefusalLog } from '../../src/auth/route-policy.js';
import { KeysManager } from './keys-manager.js';

/** Export and import of a plugin's data: documents, settings and file references (owner only, 2026-11-07). */
describe('plugin data export and import (2026-11-07)', () => {
  let app: any;
  let db: Database.Database;
  let tmp: string;
  const plugin = (id: string, permissions: string[] = ['threads:read-storage', 'threads:write-storage']) => {
    const dir = path.join(tmp, 'plugins', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', permissions }));
  };
  const asPlugin = (id: string) => ({ Authorization: `Bearer ${fs.readFileSync(path.join(tmp, 'keys', `plugin-${id}`), 'utf8').trim()}` });
  const asThread = () => ({ Authorization: `Bearer ${app.locals.keys.mint({ kind: 'thread', terminalId: 'tA' }).key}` });
  const put = (id: string, key: string, value: unknown) =>
    request(app).put(`/api/plugins/${id}/data/${key}`).set('Content-Type', 'application/json').send(JSON.stringify({ value }));
  const putSettings = (id: string, value: unknown) =>
    request(app).put(`/api/plugins/${id}/settings`).set('Content-Type', 'application/json').send(JSON.stringify({ value }));
  const importBody = (id: string, body: unknown, query = '') =>
    request(app).post(`/api/plugins/${id}/import${query}`).set('Content-Type', 'application/json').send(JSON.stringify(body));
  const file = (pluginId: string, docs: Array<{ key: string; value: unknown }>, extra: Record<string, unknown> = {}) => ({
    format: 'dispatch-plugin-data', version: 1, pluginId, exportedAt: new Date().toISOString(), settings: null,
    docs: docs.map((d) => ({ ...d, updatedAt: '2026-01-01T00:00:00.000Z' })), files: [], ...extra,
  });

  beforeEach(() => {
    configureRefusalLog({ log: () => {} });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-export-'));
    fs.writeFileSync(path.join(tmp, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    db = new Database(':memory:');
    initSchema(db);
    plugin('notes');
    plugin('other');
    const mgr = new KeysManager();
    app = createApp({ db, skipPty: true, pluginsDir: path.join(tmp, 'plugins'), secretsDir: tmp, managers: new Map([['claude-code', mgr.asManager()]]) });
    sessionsDb.create(db, { id: 'A', provider: 'claude-code', name: 'Alpha', workingDir: tmp });
    terminalsDb.create(db, { id: 'tA', sessionId: 'A', type: 'claude-code', label: 'Worker A', config: { transport: 'structured', role: 'agent' } });
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('exports documents, settings and files as a dated JSON download, and an import into a cleared plugin restores them', async () => {
    await put('notes', 'a', { n: 1 }).expect(200);
    await put('notes', 'b', 'two').expect(200);
    await putSettings('notes', { style: 'quiet' }).expect(200);
    const f = pluginData.addFile(db, 'notes', 'A', { path: path.join(tmp, 'shot.png'), name: 'shot.png', mime: 'image/png', size: 4 });

    const r = await request(app).get('/api/plugins/notes/export');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/json/);
    const day = new Date().toISOString().slice(0, 10);
    expect(r.headers['content-disposition']).toBe(`attachment; filename="notes-data-${day}.json"`);
    const body = JSON.parse(r.text);
    expect(body).toMatchObject({ format: 'dispatch-plugin-data', version: 1, pluginId: 'notes', settings: { style: 'quiet' } });
    expect(typeof body.exportedAt).toBe('string');
    expect(body.docs.map((d: any) => [d.key, d.value])).toEqual([['a', { n: 1 }], ['b', 'two']]);
    expect(typeof body.docs[0].updatedAt).toBe('string');
    expect(body.files).toEqual([expect.objectContaining({ fileId: f.fileId, sessionId: 'A', name: 'shot.png', mime: 'image/png', size: 4 })]);

    pluginData.clearPlugin(db, 'notes');
    const imp = await importBody('notes', body);
    expect(imp.status).toBe(200);
    expect(imp.body).toEqual({ docs: 2, files: 1, settings: true });
    expect((await request(app).get('/api/plugins/notes/data/a')).body.value).toEqual({ n: 1 });
    expect((await request(app).get('/api/plugins/notes/settings')).body.value).toEqual({ style: 'quiet' });
    expect(pluginData.getFile(db, 'notes', f.fileId)).toMatchObject({ name: 'shot.png', sessionId: 'A' });
    const again = JSON.parse((await request(app).get('/api/plugins/notes/export')).text);
    expect(again.docs).toEqual(body.docs);
  });

  it('exports after a remove with ?keepData=1 (the plugin folder is gone); 404 only for an unknown plugin with no data', async () => {
    await put('notes', 'a', 1).expect(200);
    await request(app).delete('/api/plugins/notes?keepData=1').expect(204);
    const r = await request(app).get('/api/plugins/notes/export');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text).docs.map((d: any) => d.key)).toEqual(['a']);
    await request(app).get('/api/plugins/nope/export').expect(404);
    // an installed plugin with no data exports an empty file
    const empty = JSON.parse((await request(app).get('/api/plugins/other/export').expect(200)).text);
    expect(empty).toMatchObject({ settings: null, docs: [], files: [] });
  });

  it('merge (the default) overwrites the same keys and keeps the others; replace clears the plugin first', async () => {
    await put('notes', 'keep', 'old').expect(200);
    await put('notes', 'a', 'old').expect(200);
    await putSettings('notes', { s: 1 }).expect(200);
    const merged = await importBody('notes', file('notes', [{ key: 'a', value: 'new' }, { key: 'b', value: 'new' }]));
    expect(merged.status).toBe(200);
    expect(merged.body).toEqual({ docs: 2, files: 0, settings: false });
    expect(pluginData.listDocs(db, 'notes', { values: true }).map((d) => [d.key, d.value])).toEqual([['a', 'new'], ['b', 'new'], ['keep', 'old']]);
    expect(pluginData.getSettings(db, 'notes')?.value).toEqual({ s: 1 });

    const replaced = await importBody('notes', file('notes', [{ key: 'c', value: 'only' }]), '?mode=replace');
    expect(replaced.status).toBe(200);
    expect(pluginData.listDocs(db, 'notes', { values: true }).map((d) => [d.key, d.value])).toEqual([['c', 'only']]);
    expect(pluginData.getSettings(db, 'notes')).toBeNull();
    await importBody('notes', file('notes', []), '?mode=nope').expect(400);
  });

  it('refuses a file of the wrong format or version with 400', async () => {
    expect((await importBody('notes', { ...file('notes', []), format: 'other' })).status).toBe(400);
    expect((await importBody('notes', { ...file('notes', []), version: 2 })).status).toBe(400);
    expect((await importBody('notes', ['not', 'an', 'object'])).status).toBe(400);
    expect((await importBody('notes', file('notes', [{ key: 'bad key', value: 1 }]))).status).toBe(400);
  });

  it("refuses another plugin's file with 400 unless ?force=1", async () => {
    const r = await importBody('notes', file('other', [{ key: 'a', value: 1 }]));
    expect(r.status).toBe(400);
    expect(pluginData.listDocs(db, 'notes')).toEqual([]);
    const forced = await importBody('notes', file('other', [{ key: 'a', value: 1 }]), '?force=1');
    expect(forced.status).toBe(200);
    expect(pluginData.getDoc(db, 'notes', 'a')?.value).toBe(1);
  });

  it('refuses an import over the storage caps with 413 and writes nothing', async () => {
    await put('notes', 'existing', 'kept').expect(200);
    const big = 'x'.repeat(pluginData.DOC_MAX_BYTES + 10);
    const tooBig = await importBody('notes', file('notes', [{ key: 'a', value: 'fine' }, { key: 'b', value: big }]), '?mode=replace');
    expect(tooBig.status).toBe(413);
    const many = Array.from({ length: pluginData.DOCS_MAX }, (_, i) => ({ key: `k${i}`, value: i }));
    const tooMany = await importBody('notes', file('notes', many));
    expect(tooMany.status).toBe(413);
    const bigSettings = await importBody('notes', file('notes', [{ key: 'a', value: 1 }], { settings: big }));
    expect(bigSettings.status).toBe(413);
    expect(pluginData.listDocs(db, 'notes', { values: true }).map((d) => [d.key, d.value])).toEqual([['existing', 'kept']]);
    // a replace frees the room the merge did not have
    const fits = await importBody('notes', file('notes', many), '?mode=replace');
    expect(fits.status).toBe(200);
    expect(fits.body.docs).toBe(pluginData.DOCS_MAX);
  });

  it('refuses a thread key and a plugin key (even its own)', async () => {
    await put('notes', 'a', 1).expect(200);
    expect((await request(app).get('/api/plugins/notes/export').set(asThread())).status).toBe(403);
    expect((await request(app).get('/api/plugins/notes/export').set(asPlugin('notes'))).status).toBe(403);
    const t = await request(app).post('/api/plugins/notes/import').set(asThread()).set('Content-Type', 'application/json').send(JSON.stringify(file('notes', [])));
    expect(t.status).toBe(403);
    const p = await request(app).post('/api/plugins/notes/import').set(asPlugin('notes')).set('Content-Type', 'application/json').send(JSON.stringify(file('notes', [])));
    expect(p.status).toBe(403);
  });
});
