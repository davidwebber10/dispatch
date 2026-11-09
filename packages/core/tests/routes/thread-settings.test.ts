// POST /api/terminals/:id/effort, GET /api/codex/model-efforts and the typed /model guard on POST /message (slash menu).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';

describe('thread settings routes', () => {
  let app: any;
  let svc: any;
  const terminal = { id: 't1', sessionId: 's1' };

  beforeEach(() => {
    const db = new Database(':memory:');
    initSchema(db);
    app = createApp({ db, skipPty: true });
    svc = app._sessionService;
  });

  it('POST /effort passes the level to the service and answers { effort, terminal }', async () => {
    const spy = vi.spyOn(svc, 'setThreadEffort').mockResolvedValue({ effort: 'high', terminal });
    const res = await request(app).post('/api/terminals/t1/effort').send({ effort: ' high ' }).expect(200);
    expect(spy).toHaveBeenCalledWith('t1', 'high');
    expect(res.body).toEqual({ effort: 'high', terminal });
  });

  it('POST /effort rejects a missing or non-string effort, and passes the service status through', async () => {
    const spy = vi.spyOn(svc, 'setThreadEffort');
    await request(app).post('/api/terminals/t1/effort').send({}).expect(400);
    await request(app).post('/api/terminals/t1/effort').send({ effort: 5 }).expect(400);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRejectedValue(Object.assign(new Error('This thread is busy'), { status: 409 }));
    const res = await request(app).post('/api/terminals/t1/effort').send({ effort: 'high' }).expect(409);
    expect(res.body.error).toMatch(/busy/);
  });

  it('POST /effort on a thread that does not exist is a 404', async () => {
    await request(app).post('/api/terminals/nope/effort').send({ effort: 'high' }).expect(404);
  });

  it('POST /model passes the Codex effort change back', async () => {
    vi.spyOn(svc, 'setThreadModel').mockResolvedValue({ model: 'gpt-6-luna', terminal, clearedEffort: 'ultra', effortNow: 'medium' });
    const res = await request(app).post('/api/terminals/t1/model').send({ model: 'gpt-6-luna' }).expect(200);
    expect(res.body).toMatchObject({ clearedEffort: 'ultra', effortNow: 'medium' });
  });

  it('GET /codex/model-efforts returns the app-server list and defaults, or null', async () => {
    const spy = vi.spyOn(svc, 'codexModelEfforts').mockResolvedValue({ 'gpt-6-luna': ['low', 'max'] });
    vi.spyOn(svc, 'codexModelDefaults').mockReturnValue({ 'gpt-6-luna': 'low' });
    const res = await request(app).get('/api/codex/model-efforts').expect(200);
    expect(res.body).toEqual({ live: { 'gpt-6-luna': ['low', 'max'] }, defaults: { 'gpt-6-luna': 'low' } });
    spy.mockResolvedValue(null);
    expect((await request(app).get('/api/codex/model-efforts').expect(200)).body).toEqual({ live: null, defaults: null });
  });

  it('POST /message: a typed command is run, answers 200 and is not sent', async () => {
    const send = vi.spyOn(svc, 'sendThreadMessage').mockReturnValue({ transport: 'structured', droppedNonText: false });
    vi.spyOn(svc, 'handleTypedSlash').mockResolvedValue(terminal);
    const res = await request(app).post('/api/terminals/t1/message').send({ text: '/model opus', source: 'user' }).expect(200);
    expect(res.body).toEqual({ handled: 'settings' });
    expect(send).not.toHaveBeenCalled();
  });

  it('POST /message: a refused or mid-turn command answers its status and is not sent', async () => {
    const send = vi.spyOn(svc, 'sendThreadMessage').mockReturnValue({ transport: 'structured', droppedNonText: false });
    vi.spyOn(svc, 'handleTypedSlash').mockRejectedValue(Object.assign(new Error('This thread is busy'), { status: 409 }));
    const res = await request(app).post('/api/terminals/t1/message').send({ text: '/effort high', source: 'user' }).expect(409);
    expect(res.body.error).toMatch(/busy/);
    expect(send).not.toHaveBeenCalled();
  });
});
