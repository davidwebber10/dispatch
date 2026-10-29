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
import { HTML_SANDBOX_CSP } from '../../src/routes/previews.js';
import { KeysManager } from './keys-manager.js';
import express from 'express';
import { createPreviewsRouter } from '../../src/routes/previews.js';

describe('previews routes', () => {
  let app: any;
  let db: Database.Database;
  let tmp: string;
  let events: Record<string, unknown>[];
  const as = (id: string) => ({ Authorization: `Bearer ${app.locals.keys.mint({ kind: 'thread', terminalId: id }).key}` });

  beforeEach(() => {
    configureRefusalLog({ log: () => {} });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'previews-'));
    db = new Database(':memory:');
    initSchema(db);
    events = [];
    const mgr = new KeysManager();
    app = createApp({ db, skipPty: true, managers: new Map([['claude-code', mgr.asManager()]]) });
    const a = path.join(tmp, 'a'); fs.mkdirSync(path.join(a, '.dispatch', 'inbox'), { recursive: true });
    const b = path.join(tmp, 'b'); fs.mkdirSync(b);
    fs.writeFileSync(path.join(a, '.dispatch', 'inbox', 'shot.png'), Buffer.from([137, 80, 78, 71]));
    fs.writeFileSync(path.join(a, 'page.html'), '<script>alert(1)</script>');
    fs.writeFileSync(path.join(a, 'notes.md'), '# hi');
    fs.writeFileSync(path.join(b, 'secret.txt'), 'nope');
    sessionsDb.create(db, { id: 'A', provider: 'claude-code', name: 'Alpha', workingDir: a });
    sessionsDb.create(db, { id: 'B', provider: 'claude-code', name: 'Beta', workingDir: b });
    terminalsDb.create(db, { id: 'tA', sessionId: 'A', type: 'claude-code', label: 'Worker A', config: { transport: 'structured', role: 'agent' } });
    terminalsDb.create(db, { id: 'tB', sessionId: 'B', type: 'claude-code', label: 'Worker B', config: { transport: 'structured', role: 'agent' } });
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('a thread posts files and text to its own project; the preview carries its context and an event goes out', async () => {
    const r = await request(app).post('/api/sessions/A/previews').set(as('tA'))
      .send({ title: 'The fix', note: 'after the rebuild', text: 'npm run build', paths: ['.dispatch/inbox/shot.png', path.join(tmp, 'a', 'notes.md')] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ sessionId: 'A', sessionName: 'Alpha', terminalId: 'tA', terminalLabel: 'Worker A', title: 'The fix', note: 'after the rebuild', text: 'npm run build', seenAt: null });
    expect(r.body.files.map((f: any) => [f.name, f.mime])).toEqual([['shot.png', 'image/png'], ['notes.md', 'text/markdown']]);
    const list = await request(app).get('/api/sessions/A/previews');
    expect(list.body.previews.map((p: any) => p.id)).toEqual([r.body.id]);
    expect(list.body.unseen).toBe(1);
    const all = await request(app).get('/api/previews');
    expect(all.body.previews).toHaveLength(1);
  });

  it('refuses a path outside the project, an unknown type, a missing file, and an empty preview', async () => {
    const post = (body: unknown) => request(app).post('/api/sessions/A/previews').set(as('tA')).send(body);
    expect((await post({ paths: [path.join(tmp, 'b', 'secret.txt')] })).body.error).toMatch(/outside the project/);
    expect((await post({ paths: ['../b/secret.txt'] })).body.error).toMatch(/outside the project/);
    fs.writeFileSync(path.join(tmp, 'a', 'x.zip'), 'z');
    expect((await post({ paths: ['x.zip'] })).body.error).toMatch(/unsupported file type/);
    expect((await post({ paths: ['nope.png'] })).status).toBe(404);
    expect((await post({})).body.error).toMatch(/needs text or at least one path/);
  });

  it('a thread cannot post into another project; the owner can post without a key', async () => {
    const r = await request(app).post('/api/sessions/B/previews').set(as('tA')).send({ text: 'x' });
    expect(r.status).toBe(403);
    const o = await request(app).post('/api/sessions/B/previews').send({ text: 'from the owner', terminalId: 'tB' });
    expect(o.status).toBe(201);
    expect(o.body.terminalLabel).toBe('Worker B');
    expect(o.body.title).toBe('Text');
  });

  it('seen and delete change the row and broadcast; a thread key may not do either', async () => {
    const r = await request(app).post('/api/sessions/A/previews').set(as('tA')).send({ text: 'x' });
    expect((await request(app).post(`/api/previews/${r.body.id}/seen`).set(as('tA'))).status).toBe(403);
    const seen = await request(app).post(`/api/previews/${r.body.id}/seen`);
    expect(seen.body.seenAt).toBeTruthy();
    expect((await request(app).get('/api/previews')).body.unseen).toBe(0);
    expect((await request(app).delete(`/api/previews/${r.body.id}`)).status).toBe(204);
    expect((await request(app).get(`/api/previews/${r.body.id}/files/0`)).status).toBe(404);
  });

  it('serves a file by index with its type; HTML gets the sandbox policy; a thread key is refused', async () => {
    const r = await request(app).post('/api/sessions/A/previews').set(as('tA')).send({ paths: ['.dispatch/inbox/shot.png', 'page.html'] });
    const png = await request(app).get(`/api/previews/${r.body.id}/files/0`);
    expect(png.status).toBe(200);
    expect(png.headers['content-type']).toContain('image/png');
    expect(png.headers['content-disposition']).toContain('inline; filename="shot.png"');
    const html = await request(app).get(`/api/previews/${r.body.id}/files/1`);
    expect(html.status).toBe(200);
    expect(html.headers['content-type']).toContain('text/html');
    expect(html.headers['content-security-policy']).toBe(HTML_SANDBOX_CSP);
    expect((await request(app).get(`/api/previews/${r.body.id}/files/2`)).status).toBe(404);
    expect((await request(app).get(`/api/previews/${r.body.id}/files/0`).set(as('tA'))).status).toBe(403);
  });

  describe('events (the router alone, with a recording broadcaster)', () => {
    it('broadcasts preview:new on a post and preview:changed on seen and delete', async () => {
      const bare = express();
      bare.use(express.json());
      bare.use('/api', createPreviewsRouter(db, { broadcast: (e) => { events.push(e); } }));
      const r = await request(bare).post('/api/sessions/A/previews').send({ text: 'x', terminalId: 'tA' });
      expect(r.status).toBe(201);
      expect(r.body.terminalLabel).toBe('Worker A');
      expect(events).toContainEqual(expect.objectContaining({ type: 'preview:new', preview: expect.objectContaining({ id: r.body.id }) }));
      const seen = await request(bare).post(`/api/previews/${r.body.id}/seen`);
      expect(events).toContainEqual(expect.objectContaining({ type: 'preview:changed', id: r.body.id, seenAt: seen.body.seenAt }));
      await request(bare).delete(`/api/previews/${r.body.id}`);
      expect(events).toContainEqual(expect.objectContaining({ type: 'preview:changed', id: r.body.id, deleted: true }));
    });
  });
});
