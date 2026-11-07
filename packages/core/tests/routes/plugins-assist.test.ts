import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { createApp } from '../../src/server.js';
import { configureRefusalLog } from '../../src/auth/route-policy.js';
import type { AssistRunner, AssistRequest } from '../../src/assist/run.js';
import { KeysManager } from './keys-manager.js';

/** Model assist for plugins (docs/superpowers/specs/2026-11-07-plugins-design.md, section 3.4). */
describe('plugin assist route (2026-11-07)', () => {
  let app: any; let db: Database.Database; let tmp: string; let calls: AssistRequest[];
  const plugin = (id: string, permissions: string[]) => {
    const dir = path.join(tmp, 'plugins', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', permissions }));
  };
  const asPlugin = (id: string) => ({ Authorization: `Bearer ${fs.readFileSync(path.join(tmp, 'keys', `plugin-${id}`), 'utf8').trim()}` });
  const fakeRunner: AssistRunner = {
    available: async () => true,
    run: async (req) => { calls.push(req); return { text: `judged: ${req.messages[0]?.content ?? ''}`, usage: { inputTokens: 120, outputTokens: 30 }, ms: 250, model: 'fake-model' }; },
  };
  const build = (runner: AssistRunner | null) => {
    const mgr = new KeysManager();
    return createApp({ db, skipPty: true, pluginsDir: path.join(tmp, 'plugins'), secretsDir: tmp, managers: new Map([['claude-code', mgr.asManager()]]), assistRunner: runner });
  };

  beforeEach(() => {
    configureRefusalLog({ log: () => {} });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-assist-'));
    db = new Database(':memory:'); initSchema(db);
    calls = [];
    plugin('coach', ['model:assist']);
    plugin('mute', []);
    app = build(fakeRunner);
    sessionsDb.create(db, { id: 'A', provider: 'claude-code', name: 'Alpha', workingDir: tmp });
    terminalsDb.create(db, { id: 'tX', sessionId: 'A', type: 'claude-code', label: 'Worker', config: { transport: 'structured', role: 'agent' } });
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('a thread key cannot drive assist (403), and a fourth call in flight for one plugin gets 429', async () => {
    const body = { messages: [{ role: 'user', content: 'x' }] };
    const thread = { Authorization: `Bearer ${app.locals.keys.mint({ kind: 'thread', terminalId: 'tX' }).key}` };
    expect((await request(app).post('/api/plugins/coach/assist').set(thread).send(body)).status).toBe(403);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const slow: AssistRunner = { available: async () => true, run: async () => { await gate; return { text: 'late', usage: { inputTokens: 1, outputTokens: 1 }, ms: 1, model: 'm' }; } };
    app = build(slow);
    // supertest sends lazily: `.then` starts each request now, so three are in flight before the fourth.
    const inflight = [1, 2, 3].map(() => request(app).post('/api/plugins/coach/assist').set(asPlugin('coach')).send(body).then((r) => r));
    await new Promise((r) => setTimeout(r, 80));
    const fourth = await request(app).post('/api/plugins/coach/assist').set(asPlugin('coach')).send(body);
    expect(fourth.status).toBe(429);
    expect(fourth.body.error).toBe('busy');
    release();
    expect((await Promise.all(inflight)).map((r) => r.status)).toEqual([200, 200, 200]);
    expect((await request(app).post('/api/plugins/coach/assist').set(asPlugin('coach')).send(body)).status).toBe(200);
  });

  it('a plugin with model:assist gets text and usage, and the call is metered on its row', async () => {
    const r = await request(app).post('/api/plugins/coach/assist').set(asPlugin('coach')).send({ system: 'You judge prompts.', messages: [{ role: 'user', content: 'Fix the bug' }], maxTokens: 300 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ text: 'judged: Fix the bug', usage: { inputTokens: 120, outputTokens: 30 }, ms: 250, model: 'fake-model' });
    expect(calls[0]).toMatchObject({ system: 'You judge prompts.', maxTokens: 300 });
    const row = (await request(app).get('/api/plugins')).body.plugins.find((p: any) => p.id === 'coach');
    expect(row.assist).toEqual({ calls: 1, inputTokens: 120, outputTokens: 30 });
  });

  it('without the permission the plugin gets 403 naming it; another plugin cannot assist as this one', async () => {
    const no = await request(app).post('/api/plugins/mute/assist').set(asPlugin('mute')).send({ messages: [{ role: 'user', content: 'x' }] });
    expect(no.status).toBe(403);
    expect(no.body.message).toContain('"model:assist"');
    const other = await request(app).post('/api/plugins/mute/assist').set(asPlugin('coach')).send({ messages: [{ role: 'user', content: 'x' }] });
    expect(other.status).toBe(403);
  });

  it('assist with no runner answers 503 with a plain message', async () => {
    app = build(null);
    const r = await request(app).post('/api/plugins/coach/assist').set(asPlugin('coach')).send({ messages: [{ role: 'user', content: 'x' }] });
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: 'no_model', message: 'No model is signed in for assist. Sign in to Claude Code or set an OpenRouter key.' });
  });

  it('the owner can call assist for a plugin; a bad body is 400; maxTokens is capped at 2000', async () => {
    const r = await request(app).post('/api/plugins/coach/assist').send({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 99999 });
    expect(r.status).toBe(200);
    expect(calls[0].maxTokens).toBe(2000);
    expect((await request(app).post('/api/plugins/coach/assist').send({})).status).toBe(400);
    expect((await request(app).post('/api/plugins/coach/assist').send({ messages: 'nope' })).status).toBe(400);
    expect((await request(app).post('/api/plugins/nope/assist').send({ messages: [{ role: 'user', content: 'x' }] })).status).toBe(404);
  });
});
