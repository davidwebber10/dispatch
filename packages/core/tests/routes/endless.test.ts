import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { EndlessService, startEndless } from '../../src/endless/service.js';
import { createEndlessRouter } from '../../src/routes/endless.js';
import { FakeSummarizer, settle } from '../endless/fake-summarizer.js';
import { FakeManager } from '../endless/fake-manager.js';
import { LedgerService } from '../../src/overseer/ledger-service.js';
import { Compactor } from '../../src/endless/compactor.js';
import { EndlessStore } from '../../src/endless/store.js';
import { claudeMemoryProjectDir, sharedProjectMemoryDir } from '../../src/overseer/memory-scope.js';
import { callTool } from '../../src/endless/memory-mcp.js';
import type { AddressInfo } from 'node:net';

let root: string;
let svc: EndlessService;
let fake: FakeManager;
let app: express.Express;
let events: Record<string, unknown>[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'endless-routes-'));
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'salsify', workingDir: path.join(root, 'salsify') });
  fake = new FakeManager();
  events = [];
  svc = new EndlessService({
    db, broadcaster: { broadcast: (e) => events.push(e) }, manager: fake.asManager(),
    chatDir: path.join(root, 'chat'), home: path.join(root, 'home'), summarizer: new FakeSummarizer(),
    timeZone: 'UTC', turn: { waitMs: 50, graceMs: 10 }, ledger: new LedgerService(db),
  });
  svc.start(3999);
  app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/endless', createEndlessRouter(svc));
});
afterEach(() => { svc.stop(); fs.rmSync(root, { recursive: true, force: true }); });

const endTurn = async () => { fake.emitEvent({ type: 'result', subtype: 'success', is_error: false }); await svc.turns.whenIdle(); };

describe('endless routes', () => {
  it('POST /ledger/:action answers 400 for a project with no Control Plane', async () => {
    const res = await request(app).post('/api/endless/ledger/list').send({ project: 'salsify' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/has no Control Plane/);
  });

  it('writes the memory MCP config in the fixed chat folder', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'chat', 'memory.mcp.json'), 'utf8'));
    expect(cfg.mcpServers.memory.env.DISPATCH_PORT).toBe('3999');
    expect(cfg.mcpServers.memory.args[0]).toMatch(/memory-mcp\.js$/);
  });

  it('POST /send logs the message, broadcasts it, and starts one turn', async () => {
    const res = await request(app).post('/api/endless/send').send({ text: 'hello', project: 's1' });
    expect(res.status).toBe(202);
    await settle();
    expect(fake.spawned).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ type: 'endless:message', message: expect.objectContaining({ i: 0, kind: 'user', text: 'hello', projectName: 'salsify' }) }));
    await endTurn();
  });

  it('two concurrent sends from two tabs start exactly one turn and log both', async () => {
    const arrived: string[] = [];
    const send = svc.send.bind(svc);
    svc.send = (body) => { arrived.push(body.text); send(body); };
    const [a, b] = await Promise.all([
      request(app).post('/api/endless/send').send({ text: 'tab A' }),
      request(app).post('/api/endless/send').send({ text: 'tab B' }),
    ]);
    expect([a.status, b.status]).toEqual([202, 202]);
    await settle();
    expect(fake.spawned).toHaveLength(1);
    const page = await request(app).get('/api/endless/messages');
    expect(page.body.messages.map((m: any) => m.text)).toEqual(arrived); // logged in arrival order
    expect(arrived.slice().sort()).toEqual(['tab A', 'tab B']);
    // The second message went to the running process (a hand-off): the CLI answers it
    // before its result, or the runner waits for the next result (HANDOFF_RESULT_CEILING_MS).
    fake.emitEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'both seen' }] } });
    await endTurn();
    expect(fake.spawned).toHaveLength(1);
  });

  it('refuses an empty message and an unknown project', async () => {
    expect((await request(app).post('/api/endless/send').send({ text: '  ' })).status).toBe(400);
    expect((await request(app).post('/api/endless/send').send({ text: 'x', project: 'nope' })).status).toBe(400);
  });

  it('saves an image, serves it, and keeps traversal out', async () => {
    const data = Buffer.from([137, 80, 78, 71]).toString('base64');
    await request(app).post('/api/endless/send').send({ text: 'see', images: [{ media_type: 'image/png', data }] });
    await settle();
    const page = await request(app).get('/api/endless/messages');
    const name = page.body.messages[0].media[0];
    expect(name).toMatch(/\.png$/);
    const img = await request(app).get(`/api/endless/media/${name}`);
    expect(img.status).toBe(200);
    expect((await request(app).get('/api/endless/media/..%2Fmemory.mcp.json')).status).toBe(404);
    await endTurn();
  });

  it('pages history, opens a window around a message, and filters by project', async () => {
    for (let k = 0; k < 6; k++) svc.log({ kind: 'user', text: `m${k}`, project: k % 2 ? 's1' : null });
    const tail = await request(app).get('/api/endless/messages?limit=2');
    expect(tail.body.messages.map((m: any) => m.i)).toEqual([4, 5]);
    expect(tail.body.hasMore).toBe(true);
    const older = await request(app).get('/api/endless/messages?limit=2&before=4');
    expect(older.body.messages.map((m: any) => m.i)).toEqual([2, 3]);
    const around = await request(app).get('/api/endless/messages?around=2&limit=2');
    expect(around.body.messages.map((m: any) => m.i)).toEqual([2, 3]);
    const s1 = await request(app).get('/api/endless/messages?project=s1');
    expect(s1.body.messages.map((m: any) => m.i)).toEqual([1, 3, 5]);
  });

  it('searches the full text and returns the inspector view', async () => {
    svc.log({ kind: 'user', text: 'the parquet exporter is slow', project: 's1' });
    await settle();
    const hits = await request(app).get('/api/endless/search?q=parquet');
    expect(hits.body.results).toHaveLength(1);
    expect(hits.body.results[0]).toMatchObject({ i: 0, projectName: 'salsify' });
    const view = await request(app).get('/api/endless/view');
    expect(view.body.lines).toEqual([{ name: '0+1', l: 0, i: 0, text: 'user (salsify): the parquet exporter is slow' }]);
    expect(view.body.bytes).toBeGreaterThan(0);
  });

  it('returns the view rendered exactly as the turn runner sends it to the model', async () => {
    svc.log({ kind: 'user', text: 'first\nsecond line', project: 's1' });
    svc.log({ kind: 'user', text: 'third' });
    await settle();
    const view = await request(app).get('/api/endless/view');
    expect(view.body.rendered).toBe((svc as any).views.turnBlocks().join(''));
    expect(view.body.rendered.startsWith('<chat>\n')).toBe(true);
    expect(view.body.rendered.endsWith('\n</chat>')).toBe(true);
  });

  it('answers zoom and date for the memory MCP, with 400 on bad input', async () => {
    svc.log({ kind: 'user', text: 'zoom me' });
    expect((await request(app).get('/api/endless/zoom?id=0&n=1')).body).toEqual({ text: '#0 user: zoom me', images: [] });
    expect((await request(app).get('/api/endless/zoom?id=0&n=3')).status).toBe(400);
    expect((await request(app).get('/api/endless/date?id=0')).body.text).toMatch(/^\w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/);
    expect((await request(app).get('/api/endless/date?id=9')).status).toBe(400);
  });

  it('stores the Chat instructions and puts them after the system prompt', async () => {
    await request(app).put('/api/endless/instructions').send({ text: 'I am David.' });
    expect((await request(app).get('/api/endless/instructions')).body).toEqual({ text: 'I am David.' });
    expect(svc.systemPrompt().endsWith('\n\nI am David.')).toBe(true);
  });

  it('reports turn state; Retry is 409 with nothing to retry', async () => {
    expect((await request(app).get('/api/endless/state')).body.turn).toEqual({ status: 'idle', error: null });
    expect((await request(app).post('/api/endless/retry')).status).toBe(409);
    expect((await request(app).post('/api/endless/stop')).status).toBe(409);
  });

  it('GET /projects returns the projects, the pane threads and the cut flag', async () => {
    const res = await request(app).get('/api/endless/projects');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.projects)).toBe(true);
    expect(res.body.projects[0]).toMatchObject({ id: 's1' });
    expect(res.body.threads).toEqual([]);
    expect(res.body.truncated).toBe(false);
  });

  it('lists projects and threads', async () => {
    expect((await request(app).get('/api/endless/projects')).body.projects[0]).toMatchObject({ id: 's1', name: 'salsify' });
    expect((await request(app).get('/api/endless/threads')).body).toEqual([]);
  });

  it('GET /doc returns a doc, 403 for a refused path, 404 when missing', async () => {
    const folder = svc.docs.project('s1')!.folder;
    fs.mkdirSync(path.join(folder, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'docs', 'a.md'), '# A\n');
    const ok = await request(app).get('/api/endless/doc').query({ project: 's1', path: 'docs/a.md' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ path: 'docs/a.md', markdown: '# A\n' });
    expect((await request(app).get('/api/endless/doc').query({ project: 's1', path: '../x.md' })).status).toBe(403);
    expect((await request(app).get('/api/endless/doc').query({ project: 's1', path: 'docs/none.md' })).status).toBe(404);
    expect((await request(app).get('/api/endless/doc').query({ project: 'nope', path: 'docs/a.md' })).status).toBe(400);
  });

  it('GET /doc passes the worktree name: the named worktree copy wins over the main checkout', async () => {
    const folder = svc.docs.project('s1')!.folder;
    fs.mkdirSync(path.join(folder, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'docs', 'a.md'), 'main');
    fs.mkdirSync(path.join(folder, '.worktrees', 'a', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(folder, '.worktrees', 'a', 'docs', 'a.md'), 'worktree');
    const res = await request(app).get('/api/endless/doc').query({ project: 's1', path: 'docs/a.md', worktree: 'a' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ path: 'docs/a.md', source: 'worktree', worktree: 'a', markdown: 'worktree' });
    expect((await request(app).get('/api/endless/doc').query({ project: 's1', path: 'docs/a.md' })).body).toMatchObject({ source: 'main', markdown: 'main' });
  });

  it('GET /doc returns 413 for a file over 2 MB', async () => {
    const folder = svc.docs.project('s1')!.folder;
    fs.mkdirSync(path.join(folder, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'docs', 'big.md'), 'x'.repeat(2 * 1024 * 1024 + 1));
    const res = await request(app).get('/api/endless/doc').query({ project: 's1', path: 'docs/big.md' });
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ path: 'docs/big.md', size: 2 * 1024 * 1024 + 1 });
  });

  it('GET /docs and /docs/counts answer for a project that is not a repo', async () => {
    fs.mkdirSync(path.join(root, 'salsify'), { recursive: true });
    expect((await request(app).get('/api/endless/docs').query({ project: 's1' })).body).toEqual({ rows: [], total: 0 });
    expect((await request(app).get('/api/endless/docs/counts').query({ projects: 's1' })).body).toEqual({ counts: { s1: 0 } });
    expect((await request(app).get('/api/endless/docs').query({ project: 'nope' })).status).toBe(400);
  });

  it('GET /docs and /docs/counts answer 500 on an unexpected error', async () => {
    vi.spyOn(svc.docs, 'list').mockRejectedValue(new Error('boom'));
    vi.spyOn(svc.docs, 'counts').mockRejectedValue(new Error('boom'));
    expect((await request(app).get('/api/endless/docs').query({ project: 's1' })).status).toBe(500);
    expect((await request(app).get('/api/endless/docs/counts').query({ projects: 's1' })).status).toBe(500);
  });

  it('POST /arm arms a Chat thread and refuses an unknown or a non-Chat one', async () => {
    const db = (svc as any).o.db as Database.Database;
    terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 'Fix', config: { role: 'agent', origin: 'endless' } });
    terminalsDb.create(db, { id: 't2', sessionId: 's1', type: 'claude-code', label: 'Mine', config: { role: 'agent' } });
    expect((await request(app).post('/api/endless/arm').send({ terminalId: 't1' })).body).toEqual({ armed: true });
    expect(svc.store.owedReports('t1')).toBe(1);
    const bad = await request(app).post('/api/endless/arm').send({ terminalId: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('unknown thread: nope');
    const mine = await request(app).post('/api/endless/arm').send({ terminalId: 't2' });
    expect(mine.status).toBe(400);
    expect(mine.body.error).toBe('not a Chat thread: t2');
    expect(svc.store.hasPendingReport('t2')).toBe(false);
  });
});

describe('a failed send owes no report (final review I-2)', () => {
  /** The real Chat routes on a local port, with stand-in thread routes whose message send fails. */
  async function serve() {
    const db = (svc as any).o.db as Database.Database;
    const seen: string[] = [];
    const full = express();
    full.use(express.json());
    full.use((req, _res, next) => { seen.push(`${req.method} ${req.path}`); next(); });
    full.use('/api/endless', createEndlessRouter(svc));
    full.get('/api/sessions/s1/overseer/worker-defaults', (_req, res) => { res.json({ harness: 'claude-code', available: true }); });
    full.post('/api/sessions/s1/terminals', (req, res) => {
      terminalsDb.create(db, { id: 't9', sessionId: 's1', type: 'claude-code', label: 'Fix', config: req.body.config });
      res.status(201).json({ id: 't9' });
    });
    full.post('/api/terminals/:id/message', (_req, res) => { res.status(500).json({ error: 'the thread did not start' }); });
    full.delete('/api/terminals/:id', (_req, res) => { res.status(204).end(); });
    const server = full.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    vi.stubEnv('DISPATCH_API', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    return { db, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
  }
  afterEach(() => { vi.unstubAllEnvs(); });

  it('message_thread: the send fails → the arm is taken back, owed 0, the error returns', async () => {
    const s = await serve();
    try {
      terminalsDb.create(s.db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 'Fix', config: { role: 'agent', origin: 'endless' } });
      const r = await callTool('message_thread', { id: 't1', text: 'Also fix the logout.' });
      expect(r.isError).toBe(true);
      expect((r.content[0] as any).text).toMatch(/the thread did not start/);
      expect(svc.store.owedReports('t1')).toBe(0);
      expect(s.seen).toEqual(['POST /api/endless/arm', 'POST /api/terminals/t1/message', 'POST /api/endless/disarm']);
    } finally { await s.close(); }
  });

  it('message_thread: a failed send takes back only its own arm', async () => {
    const s = await serve();
    try {
      terminalsDb.create(s.db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 'Fix', config: { role: 'agent', origin: 'endless' } });
      svc.arm('t1'); // an earlier job still owes its report
      await callTool('message_thread', { id: 't1', text: 'more' });
      expect(svc.store.owedReports('t1')).toBe(1);
    } finally { await s.close(); }
  });

  it('spawn_agent: the send fails → disarm, then delete the empty thread; owed 0', async () => {
    const s = await serve();
    try {
      const r = await callTool('spawn_agent', { project: 'salsify', agentType: 'implementer', task: 'Fix it' });
      expect(r.isError).toBe(true);
      expect((r.content[0] as any).text).toMatch(/the thread did not start/);
      expect(svc.store.owedReports('t9')).toBe(0);
      expect(s.seen.slice(-3)).toEqual(['POST /api/terminals/t9/message', 'POST /api/endless/disarm', 'DELETE /api/terminals/t9']);
    } finally { await s.close(); }
  });

  it('POST /disarm takes back one owed report', async () => {
    const db = (svc as any).o.db as Database.Database;
    terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 'Fix', config: { role: 'agent', origin: 'endless' } });
    svc.arm('t1');
    svc.arm('t1');
    expect((await request(app).post('/api/endless/disarm').send({ terminalId: 't1' })).body).toEqual({ disarmed: true });
    expect(svc.store.owedReports('t1')).toBe(1);
    await request(app).post('/api/endless/disarm').send({ terminalId: 't1' });
    expect((await request(app).post('/api/endless/disarm').send({ terminalId: 't1' })).body).toEqual({ disarmed: false });
    expect(svc.store.owedReports('t1')).toBe(0);
  });
});

describe('endless service boot', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('recovers exactly once, before any message reaches the compactor, then imports through the log', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'endless-boot-'));
    const home = path.join(dir, 'home');
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    const memDir = sharedProjectMemoryDir(home, claudeMemoryProjectDir(proj).dir!);
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '- uses pnpm\n');
    const db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'proj', workingDir: proj });
    new EndlessStore(db).append({ kind: 'user', text: 'left unbuilt by a stopped daemon' });

    const calls: string[] = [];
    const recover = Compactor.prototype.recover;
    const onMessage = Compactor.prototype.onMessage;
    vi.spyOn(Compactor.prototype, 'recover').mockImplementation(function (this: Compactor) { calls.push('recover'); return recover.call(this); });
    vi.spyOn(Compactor.prototype, 'onMessage').mockImplementation(function (this: Compactor, i: number) { calls.push(`onMessage ${i}`); return onMessage.call(this, i); });

    const seen: Record<string, unknown>[] = [];
    const s = new EndlessService({
      db, broadcaster: { broadcast: (e) => seen.push(e) }, manager: new FakeManager().asManager(),
      chatDir: path.join(dir, 'chat'), home, summarizer: new FakeSummarizer(), timeZone: 'UTC',
    });
    expect(calls).toEqual([]);
    s.start(3999);
    s.start(3999); // a second start must not recover again (it would drop the unbuilt list)
    expect(calls).toEqual(['recover', 'onMessage 1']);
    expect(s.compactor.stats().unbuilt).toBe(2);
    expect(seen).toContainEqual(expect.objectContaining({ type: 'endless:message', message: expect.objectContaining({ i: 1, kind: 'note', projectName: 'proj' }) }));
    expect(s.viewLines().lines.map((l) => l.name)).toEqual(['0+1', '1+1']);
    s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('endless fix round 1', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'endless-fix-')); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

  const make = (db: Database.Database, m: FakeManager, chatDir = path.join(dir, 'chat')) => new EndlessService({
    db, broadcaster: { broadcast: () => {} }, manager: m.asManager(),
    chatDir, home: path.join(dir, 'home'), summarizer: new FakeSummarizer(),
    timeZone: 'UTC', turn: { waitMs: 50, graceMs: 10 },
  });

  it('a turn killed after the DB closes (daemon shutdown) ends without a throw; the next boot marks it interrupted', async () => {
    const file = path.join(dir, 'dispatch.db');
    const db = new Database(file);
    initSchema(db);
    const m = new FakeManager();
    const s = make(db, m);
    s.start(3999);
    s.send({ text: 'long job', project: null, images: [] });
    await settle();
    expect(m.spawned).toHaveLength(1);
    expect(s.state().turn.status).toBe('running');

    const rejections: unknown[] = [];
    const onRejection = (r: unknown) => { rejections.push(r); };
    process.on('unhandledRejection', onRejection);
    try {
      // cleanup(): endless.stop(); endlessManager.killAll() (its kill emits 'exit' synchronously); … db.close().
      s.stop();
      db.close();
      m.emitExit(143);
      await expect(s.turns.whenIdle()).resolves.toBeUndefined();
      await settle();
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }

    const db2 = new Database(file);
    const s2 = make(db2, new FakeManager());
    s2.start(3999);
    expect(s2.state().turn).toEqual({ status: 'interrupted', error: null });
    s2.stop();
    db2.close();
  });

  it('a failed start disables only the chat: its routes answer 503, other routes still work', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    const blocker = path.join(dir, 'not-a-folder');
    fs.writeFileSync(blocker, 'x'); // mkdir under a file fails
    const s = make(db, new FakeManager(), path.join(blocker, 'chat'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => startEndless(s, 3999)).not.toThrow();
    expect(errors).toHaveBeenCalled();
    const a = express();
    a.use(express.json());
    a.use('/api/endless', createEndlessRouter(s));
    a.get('/api/other', (_req, res) => { res.json({ ok: true }); });
    const state = await request(a).get('/api/endless/state');
    expect(state.status).toBe(503);
    expect(state.body).toEqual({ error: 'Chat is unavailable' });
    expect((await request(a).post('/api/endless/send').send({ text: 'hi' })).status).toBe(503);
    expect((await request(a).get('/api/other')).body).toEqual({ ok: true });
    s.stop();
  });

  it('a corrupt saved view does not throw at construction; start fails and the chat routes answer 503', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    new EndlessStore(db).setState('view', '{not json');
    let s: EndlessService | undefined;
    expect(() => { s = make(db, new FakeManager()); }).not.toThrow();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(startEndless(s!, 3999)).toBe(false);
    expect(errors).toHaveBeenCalled();
    expect(s!.available).toBe(false);
    const a = express();
    a.use(express.json());
    a.use('/api/endless', createEndlessRouter(s!));
    expect((await request(a).get('/api/endless/state')).status).toBe(503);
    s!.stop();
  });

  it('GET /project resolves a name and explains an unknown one', async () => {
    const ok = await request(app).get('/api/endless/project?ref=SALSIFY');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ id: 's1', name: 'salsify', folder: path.join(root, 'salsify') });
    const bad = await request(app).get('/api/endless/project?ref=nope');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('unknown project "nope". Known projects: salsify');
  });

  it('refuses an image entry that is not an object with 400', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    const m = new FakeManager();
    const s = make(db, m);
    s.start(3999);
    const a = express();
    a.use(express.json());
    a.use('/api/endless', createEndlessRouter(s));
    for (const images of [[null], ['x'], [{ media_type: 'image/png' }]]) {
      const res = await request(a).post('/api/endless/send').send({ text: 'see', images });
      expect(res.status).toBe(400);
      expect(typeof res.body.error).toBe('string');
    }
    await settle();
    expect(m.spawned).toHaveLength(0);
    expect(s.store.count()).toBe(0);
    s.stop();
  });
});
