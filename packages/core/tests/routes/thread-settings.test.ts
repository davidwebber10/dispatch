// PATCH /api/terminals/:id/settings and the typed /model guard on POST /message (slash menu, 2026-11-06).
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

  it('PATCH passes the change to the service and returns the terminal and when it applies', async () => {
    const spy = vi.spyOn(svc, 'setThreadSettings').mockResolvedValue({ terminal, applied: 'now' });
    const res = await request(app).patch('/api/terminals/t1/settings').send({ model: 'opus', effort: 'high' }).expect(200);
    expect(spy).toHaveBeenCalledWith('t1', { model: 'opus', effort: 'high' });
    expect(res.body).toEqual({ terminal, applied: 'now' });
  });

  it('PATCH accepts model null (reset) and an effort alone', async () => {
    const spy = vi.spyOn(svc, 'setThreadSettings').mockResolvedValue({ terminal, applied: 'next-start' });
    await request(app).patch('/api/terminals/t1/settings').send({ model: null }).expect(200);
    expect(spy).toHaveBeenLastCalledWith('t1', { model: null });
    await request(app).patch('/api/terminals/t1/settings').send({ effort: 'low' }).expect(200);
    expect(spy).toHaveBeenLastCalledWith('t1', { effort: 'low' });
  });

  it('PATCH rejects the wrong types, and passes the service status through', async () => {
    const spy = vi.spyOn(svc, 'setThreadSettings');
    await request(app).patch('/api/terminals/t1/settings').send({ model: 5 }).expect(400);
    await request(app).patch('/api/terminals/t1/settings').send({ effort: ['x'] }).expect(400);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRejectedValue(Object.assign(new Error('Only a Pretty thread'), { status: 409 }));
    const res = await request(app).patch('/api/terminals/t1/settings').send({ model: 'opus' }).expect(409);
    expect(res.body.error).toMatch(/Pretty/);
  });

  it('PATCH on a thread that does not exist is a 404', async () => {
    await request(app).patch('/api/terminals/nope/settings').send({ model: 'opus' }).expect(404);
  });

  it('POST /message: a typed command is run, answers 200 and is not sent', async () => {
    const send = vi.spyOn(svc, 'sendThreadMessage').mockReturnValue({ transport: 'structured', droppedNonText: false });
    vi.spyOn(svc, 'handleTypedSlash').mockResolvedValue(terminal);
    const res = await request(app).post('/api/terminals/t1/message').send({ text: '/model opus', source: 'user' }).expect(200);
    expect(res.body).toEqual({ handled: 'settings' });
    expect(send).not.toHaveBeenCalled();
  });

  it('POST /message: a refused command answers its status and is not sent', async () => {
    const send = vi.spyOn(svc, 'sendThreadMessage').mockReturnValue({ transport: 'structured', droppedNonText: false });
    vi.spyOn(svc, 'handleTypedSlash').mockRejectedValue(Object.assign(new Error('Unknown effort'), { status: 400 }));
    const res = await request(app).post('/api/terminals/t1/message').send({ text: '/effort turbo', source: 'user' }).expect(400);
    expect(res.body.error).toMatch(/effort/);
    expect(send).not.toHaveBeenCalled();
  });
});
