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

/** POST /api/skills (coach spec section 4.8, plan Task 12d): the owner creates a skill in one click. */
describe('POST /api/skills', () => {
  let app: any; let db: Database.Database; let tmp: string;
  const O = { Origin: 'http://127.0.0.1:3456' };
  const post = (body: unknown, headers: Record<string, string> = O) => request(app).post('/api/skills').set(headers).set('Content-Type', 'application/json').send(JSON.stringify(body));
  const asThread = () => ({ Authorization: `Bearer ${app.locals.keys.mint({ kind: 'thread', terminalId: 'tA' }).key}` });
  const DRAFT = { id: 'test-and-list', name: 'Test and list', description: 'Run the tests and list the files you changed.', body: '# Test and list\n\nAlways run the tests before you finish, and list every file you changed.' };

  beforeEach(() => {
    configureRefusalLog({ log: () => {} });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-create-'));
    db = new Database(':memory:'); initSchema(db);
    fs.mkdirSync(path.join(tmp, 'plugins'), { recursive: true });
    const mgr = new KeysManager();
    app = createApp({ db, skipPty: true, pluginsDir: path.join(tmp, 'plugins'), secretsDir: tmp, managers: new Map([['claude-code', mgr.asManager()]]) });
    sessionsDb.create(db, { id: 'A', provider: 'claude-code', name: 'Alpha', workingDir: tmp });
    sessionsDb.create(db, { id: 'B', provider: 'claude-code', name: 'Beta', workingDir: tmp });
    terminalsDb.create(db, { id: 'tA', sessionId: 'A', type: 'claude-code', label: 'Worker A', config: { transport: 'structured', role: 'agent' } });
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('201: writes SKILL.md and skill.json, enables the skill, and lists it', async () => {
    const r = await post(DRAFT);
    expect(r.status).toBe(201);
    expect(r.body.skill).toMatchObject({ id: 'test-and-list', name: 'Test and list', description: DRAFT.description, enabled: true });
    const folder = path.join(tmp, 'skills', 'test-and-list');
    expect(fs.readFileSync(path.join(folder, 'SKILL.md'), 'utf8')).toBe(DRAFT.body + '\n');
    expect(JSON.parse(fs.readFileSync(path.join(folder, 'skill.json'), 'utf8'))).toMatchObject({ id: 'test-and-list', name: 'Test and list', version: '1.0.0', description: DRAFT.description });
    const list = await request(app).get('/api/skills?project=A');
    expect(list.body.skills.map((s: any) => [s.id, s.enabled, s.enabledHere])).toEqual([['test-and-list', true, true]]);
  });

  it('409 for an id that exists; 400 for a bad slug, a missing field, or a body over 64 KB', async () => {
    expect((await post(DRAFT)).status).toBe(201);
    expect((await post(DRAFT)).status).toBe(409);
    expect((await post({ ...DRAFT, id: 'Bad Slug' })).status).toBe(400);
    expect((await post({ ...DRAFT, id: '../escape' })).status).toBe(400);
    expect((await post({ ...DRAFT, id: 'ok-id', name: '' })).status).toBe(400);
    expect((await post({ ...DRAFT, id: 'ok-id', body: 'x'.repeat(64 * 1024 + 1) })).status).toBe(400);
    expect(fs.existsSync(path.join(tmp, 'skills', 'ok-id'))).toBe(false);
  });

  it('owner only: a thread key is refused and nothing is written', async () => {
    const r = await post(DRAFT, asThread());
    expect(r.status).toBe(403);
    expect(fs.existsSync(path.join(tmp, 'skills', 'test-and-list'))).toBe(false);
  });

  it('projects: the skill reaches only the projects named', async () => {
    const r = await post({ ...DRAFT, projects: ['A'] });
    expect(r.status).toBe(201);
    expect(r.body.skill.projects).toEqual(['A']);
    expect((await request(app).get('/api/skills?project=A')).body.skills[0].enabledHere).toBe(true);
    expect((await request(app).get('/api/skills?project=B')).body.skills[0].enabledHere).toBe(false);
    expect((await post({ ...DRAFT, id: 'other', projects: ['A', 7] })).status).toBe(400);
  });
});
