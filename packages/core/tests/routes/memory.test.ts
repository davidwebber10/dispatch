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

/** /api/memory (spec 2026-11-17-memory-design.md, part 6): the person, thread keys, scopes. */
describe('memory routes', () => {
  let app: any;
  let db: Database.Database;
  let tmp: string;
  const key = (terminalId: string) => ({ Authorization: `Bearer ${app.locals.keys.mint({ kind: 'thread', terminalId }).key}` });
  const shellKey = (terminalId: string) => ({ Authorization: `Bearer ${app.locals.keys.mint({ kind: 'shell', terminalId }).key}` });

  beforeEach(() => {
    configureRefusalLog({ log: () => {} });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-routes-'));
    db = new Database(':memory:');
    initSchema(db);
    app = createApp({ db, skipPty: true });
    for (const id of ['A', 'B']) {
      fs.mkdirSync(path.join(tmp, id));
      sessionsDb.create(db, { id, provider: 'claude-code', name: `proj-${id}`, workingDir: path.join(tmp, id) });
    }
    terminalsDb.create(db, { id: 'cA', sessionId: 'A', type: 'claude-code', label: 'claude in A', config: { transport: 'structured' } });
    terminalsDb.create(db, { id: 'xA', sessionId: 'A', type: 'codex', label: 'codex in A', config: { transport: 'structured' } });
    terminalsDb.create(db, { id: 'cB', sessionId: 'B', type: 'claude-code', label: 'claude in B', config: { transport: 'structured' } });
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('a note written in a Claude Code thread is found by a Codex thread of the same project, not by another project', async () => {
    const saved = await request(app).post('/api/memory/notes').set(key('cA')).send({ text: 'Integration tests need FOO=1.' });
    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({ scope: 'project:A', origin: 'thread', terminalId: 'cA', harness: 'claude-code' });
    const found = await request(app).get('/api/memory/search').query({ q: 'integration' }).set(key('xA'));
    expect(found.status).toBe(200);
    expect(found.body.results).toEqual([expect.objectContaining({ kind: 'note', scope: 'project:A' })]);
    const other = await request(app).get('/api/memory/search').query({ q: 'integration' }).set(key('cB'));
    expect(other.body.results).toEqual([]);
  });

  it('a thread key cannot read another project\'s scope', async () => {
    const page = (await request(app).post('/api/memory/pages').send({ scope: 'project:B', slug: 'secret-plan', body: 'B only' })).body;
    expect((await request(app).get('/api/memory/pages').query({ scope: 'project:B' }).set(key('cA'))).status).toBe(403);
    expect((await request(app).get(`/api/memory/pages/${page.id}`).set(key('cA'))).status).toBe(403);
    expect((await request(app).get('/api/memory/read').query({ slug: 'secret-plan' }).set(key('cA'))).status).toBe(404);
    expect((await request(app).get('/api/memory/read').query({ slug: 'secret-plan' }).set(key('cB'))).status).toBe(200);
    // The scope in the body is not a way out: "project" is the caller's own.
    const n = await request(app).post('/api/memory/notes').set(key('cA')).send({ text: 'x', scope: 'project:B' });
    expect(n.status).toBe(400);
  });

  it('a thread key may not write pages, delete notes, read the block, or change settings', async () => {
    expect((await request(app).post('/api/memory/pages').set(key('cA')).send({ scope: 'project:A', slug: 'x' })).status).toBe(403);
    const note = (await request(app).post('/api/memory/notes').set(key('cA')).send({ text: 'x' })).body;
    expect((await request(app).delete(`/api/memory/notes/${note.id}`).set(key('cA'))).status).toBe(403);
    expect((await request(app).get('/api/memory/block').set(key('cA'))).status).toBe(403);
    expect((await request(app).put('/api/memory/settings').set(key('cA')).send({ paused: true })).status).toBe(403);
    expect((await request(app).put('/api/memory/threads/cA').set(key('cA')).send({ offRecord: false })).status).toBe(403);
    // A shell key is not a thread.
    expect((await request(app).post('/api/memory/notes').set(shellKey('cA')).send({ text: 'x' })).status).toBe(403);
  });

  it('an off-the-record thread cannot write a note; a paused memory saves nothing; the person still can', async () => {
    expect((await request(app).put('/api/memory/threads/cA').send({ offRecord: true })).status).toBe(200);
    const refused = await request(app).post('/api/memory/notes').set(key('cA')).send({ text: 'x' });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/off the record/);
    expect((await request(app).get('/api/memory/threads/cA')).body).toEqual({ offRecord: true });
    expect((await request(app).post('/api/memory/notes').set(key('xA')).send({ text: 'y' })).status).toBe(201);
    await request(app).put('/api/memory/settings').send({ paused: true });
    expect((await request(app).post('/api/memory/notes').set(key('xA')).send({ text: 'z' })).body.error).toMatch(/paused/);
    expect((await request(app).post('/api/memory/notes').send({ scope: 'you', text: 'by hand' })).status).toBe(201);
    expect((await request(app).put('/api/memory/threads/nope').send({ offRecord: true })).status).toBe(404);
  });

  it('remember: "you" goes to You; a project that is not remembered falls back to You; memory off refuses', async () => {
    expect((await request(app).post('/api/memory/notes').set(key('cA')).send({ text: 'Short replies.', scope: 'you' })).body.scope).toBe('you');
    await request(app).put('/api/memory/settings').send({ projectsOff: ['A'] });
    expect((await request(app).post('/api/memory/notes').set(key('cA')).send({ text: 'x' })).body.scope).toBe('you');
    expect((await request(app).post('/api/memory/notes').set(key('cA')).send({ text: 'x', scope: 'project' })).status).toBe(403);
    await request(app).put('/api/memory/settings').send({ enabled: false });
    expect((await request(app).post('/api/memory/notes').set(key('cA')).send({ text: 'x' })).status).toBe(403);
    expect((await request(app).get('/api/memory/search').query({ q: 'x' }).set(key('cA'))).status).toBe(403);
    expect((await request(app).get('/api/memory/block').query({ project: 'A' })).body.text).toBe('');
  });

  it('memory_read: by slug, the project first; counts the read; shows newer notes about the page', async () => {
    await request(app).post('/api/memory/pages').send({ scope: 'you', slug: 'testing', body: 'you version' });
    const p = (await request(app).post('/api/memory/pages').send({ scope: 'project:A', slug: 'testing', description: 'Tests', body: 'project version' })).body;
    await request(app).post('/api/memory/notes').set(key('xA')).send({ text: 'Also set BAR=2.', about: 'testing' });
    const r = await request(app).get('/api/memory/read').query({ slug: 'testing' }).set(key('cA'));
    expect(r.status).toBe(200);
    expect(r.body.page).toMatchObject({ id: p.id, body: 'project version', readCount: 1 });
    expect(r.body.notes.map((n: any) => n.text)).toEqual(['Also set BAR=2.']);
    expect((await request(app).get('/api/memory/read').query({ slug: 'testing', scope: 'you' }).set(key('cA'))).body.page.body).toBe('you version');
  });

  it('the person: create, edit with the sha, pin, history, restore, delete; scopes and the block', async () => {
    const created = await request(app).post('/api/memory/pages').send({ scope: 'project:A', slug: 'deploy', description: 'How to deploy', body: 'one' });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect((await request(app).put(`/api/memory/pages/${id}`).send({ body: 'two', expectedSha: created.body.sha })).status).toBe(200);
    expect((await request(app).put(`/api/memory/pages/${id}`).send({ body: 'three', expectedSha: created.body.sha })).status).toBe(409);
    expect((await request(app).put(`/api/memory/pages/${id}`).send({ pinned: true })).body.pinned).toBe(true);
    const versions = (await request(app).get(`/api/memory/pages/${id}/versions`)).body.versions;
    expect(versions.map((v: any) => v.op)).toEqual(['pin', 'edit', 'create']);
    expect((await request(app).post(`/api/memory/pages/${id}/restore`).send({ versionId: versions[2].id })).body.body).toBe('one');
    const scopes = (await request(app).get('/api/memory/scopes')).body.scopes;
    // You first; the projects in the projects' own order (sort order, then activity).
    expect(scopes[0].label).toBe('You');
    expect(scopes.slice(1).map((s: any) => s.label).sort()).toEqual(['proj-A', 'proj-B']);
    expect(scopes.find((s: any) => s.scope === 'project:A')).toMatchObject({ pages: 1, remembered: true });
    const block = (await request(app).get('/api/memory/block').query({ project: 'A', harness: 'codex' })).body;
    expect(block.text).toContain('### This project\n- deploy: How to deploy');
    expect(block.chars).toBeLessThanOrEqual(block.cap);
    expect((await request(app).delete(`/api/memory/pages/${id}`)).status).toBe(200);
    expect((await request(app).get(`/api/memory/pages/${id}`)).status).toBe(404);
    expect((await request(app).get('/api/memory/pages/abc')).status).toBe(404);
  });

  it('settings: defaults, merge, the cap is clamped', async () => {
    expect((await request(app).get('/api/memory/settings')).body).toMatchObject({ enabled: true, paused: false, blockChars: 4000, available: true });
    expect((await request(app).put('/api/memory/settings').send({ blockChars: 50000 })).body.blockChars).toBe(8000);
  });
});
