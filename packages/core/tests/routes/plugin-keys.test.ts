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
import { KeysManager } from './keys-manager.js';

/** Plugin keys on the read routes (docs/superpowers/specs/2026-11-07-plugins-design.md, section 6): each route needs its permission. */
describe('plugin keys on the read routes (2026-11-07)', () => {
  let app: any;
  let db: Database.Database;
  let tmp: string;
  const plugin = (id: string, permissions: string[]) => {
    const dir = path.join(tmp, 'plugins', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', permissions }));
  };
  const asPlugin = (id: string) => ({ Authorization: `Bearer ${fs.readFileSync(path.join(tmp, 'keys', `plugin-${id}`), 'utf8').trim()}` });

  beforeEach(async () => {
    configureRefusalLog({ log: () => {} });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-keys-'));
    db = new Database(':memory:');
    initSchema(db);
    plugin('reader', ['read:projects', 'read:threads', 'read:ledger', 'read:previews']);
    plugin('writer', ['read:ledger', 'write:ledger']);
    plugin('nothing', []);
    const mgr = new KeysManager();
    app = createApp({ db, skipPty: true, pluginsDir: path.join(tmp, 'plugins'), secretsDir: tmp, managers: new Map([['claude-code', mgr.asManager()]]) });
    sessionsDb.create(db, { id: 'A', provider: 'claude-code', name: 'Alpha', workingDir: tmp });
    terminalsDb.create(db, { id: 'tA', sessionId: 'A', type: 'claude-code', label: 'Worker A', config: { transport: 'structured', role: 'agent' } });
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('read:projects lists sessions; without it the refusal names the permission', async () => {
    const ok = await request(app).get('/api/sessions').set(asPlugin('reader'));
    expect(ok.status).toBe(200);
    expect(ok.body.map((s: any) => s.id)).toEqual(['A']);
    const no = await request(app).get('/api/sessions').set(asPlugin('nothing'));
    expect(no.status).toBe(403);
    expect(no.body.message).toBe('The plugin "nothing" lacks the permission "read:projects".');
  });

  it('read:threads opens the terminal list and a terminal', async () => {
    expect((await request(app).get('/api/sessions/A/terminals').set(asPlugin('reader'))).status).toBe(200);
    expect((await request(app).get('/api/terminals/tA').set(asPlugin('reader'))).status).toBe(200);
    expect((await request(app).get('/api/terminals/tA/conversation').set(asPlugin('reader'))).status).toBe(200);
    expect((await request(app).get('/api/terminals/tA').set(asPlugin('writer'))).status).toBe(403);
  });

  it('read:ledger opens the ledger card; the thread-only ledger routes stay closed to a plugin key', async () => {
    const card = await request(app).get('/api/sessions/A/ledger/card').set(asPlugin('reader'));
    expect(card.status).toBe(200);
    const no = await request(app).get('/api/sessions/A/ledger/card').set(asPlugin('nothing'));
    expect(no.status).toBe(403);
    expect(no.body.message).toContain('"read:ledger"');
    expect((await request(app).post('/api/sessions/A/ledger/list').set(asPlugin('reader')).send({})).status).toBe(403);
    expect((await request(app).post('/api/sessions/A/ledger').set(asPlugin('writer')).send({ title: 'x' })).status).toBe(403);
  });

  it('read:previews opens the previews lists', async () => {
    expect((await request(app).get('/api/previews').set(asPlugin('reader'))).status).toBe(200);
    expect((await request(app).get('/api/sessions/A/previews').set(asPlugin('reader'))).status).toBe(200);
    expect((await request(app).get('/api/previews').set(asPlugin('writer'))).status).toBe(403);
  });

  it('a thread key still lists previews, and the owner too', async () => {
    const thread = { Authorization: `Bearer ${app.locals.keys.mint({ kind: 'thread', terminalId: 'tA' }).key}` };
    expect((await request(app).get('/api/previews').set(thread)).status).toBe(200);
    expect((await request(app).get('/api/previews')).status).toBe(200);
  });
});
