import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createAuthRouter } from '../../src/routes/auth.js';
import { AuthRequestService } from '../../src/auth/service.js';
import type { EventBroadcaster } from '../../src/ws/events.js';

class CapturingBroadcaster implements EventBroadcaster {
  events: Record<string, unknown>[] = [];

  broadcast(event: Record<string, unknown>): void {
    this.events.push(event);
  }
}

describe('auth request routes', () => {
  let app: express.Express;
  let broadcaster: CapturingBroadcaster;
  let service: AuthRequestService;

  beforeEach(() => {
    broadcaster = new CapturingBroadcaster();
    service = new AuthRequestService(broadcaster);
    app = express();
    app.use(express.json());
    app.use('/api/auth-requests', createAuthRouter(service));
  });

  it('creates an auth request and broadcasts it', async () => {
    const res = await request(app)
      .post('/api/auth-requests')
      .send({ url: 'https://example.com/oauth?client_id=abc', source: 'browser-env', terminalId: 't1', cwd: '/tmp/project' });

    expect(res.status).toBe(201);
    expect(res.body.id).toEqual(expect.any(String));
    expect(res.body.url).toBe('https://example.com/oauth?client_id=abc');
    expect(res.body.status).toBe('pending');
    expect(res.body.terminalId).toBe('t1');
    expect(broadcaster.events).toHaveLength(1);
    expect(broadcaster.events[0]).toMatchObject({ type: 'auth:request', request: { id: res.body.id, status: 'pending' } });
  });

  it('rejects invalid auth request URLs without broadcasting', async () => {
    const res = await request(app)
      .post('/api/auth-requests')
      .send({ url: 'not a url', source: 'browser-env' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid URL/);
    expect(broadcaster.events).toHaveLength(0);
  });

  it('lists recent auth requests', async () => {
    const first = await request(app)
      .post('/api/auth-requests')
      .send({ url: 'https://example.com/login', source: 'browser-env' });
    const second = await request(app)
      .post('/api/auth-requests')
      .send({ url: 'https://example.com/second', source: 'browser-env' });

    const list = await request(app).get('/api/auth-requests');

    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);
    expect(list.body.map((record: { id: string }) => record.id)).toEqual([second.body.id, first.body.id]);
  });

  it('marks a request opened and broadcasts auth:updated', async () => {
    const create = await request(app)
      .post('/api/auth-requests')
      .send({ url: 'https://example.com/login', source: 'browser-env' });

    const opened = await request(app).post(`/api/auth-requests/${create.body.id}/opened`);

    expect(opened.status).toBe(200);
    expect(opened.body.status).toBe('opened');
    expect(broadcaster.events.at(-1)).toMatchObject({ type: 'auth:updated', request: { id: create.body.id, status: 'opened' } });
  });

  it('rejects non-loopback callback forwarding', async () => {
    const create = await request(app)
      .post('/api/auth-requests')
      .send({ url: 'https://example.com/login', source: 'browser-env' });

    const callback = await request(app)
      .post(`/api/auth-requests/${create.body.id}/callback`)
      .send({ url: 'https://evil.example/callback?code=abc' });

    expect(callback.status).toBe(400);
    expect(callback.body.error).toMatch(/loopback/);
  });

  it('forwards loopback callback URLs from the server host using injected fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 204, text: async () => '' });
    service = new AuthRequestService(broadcaster, { fetch: fetchMock as any });
    app = express();
    app.use(express.json());
    app.use('/api/auth-requests', createAuthRouter(service));

    const create = await request(app)
      .post('/api/auth-requests')
      .send({ url: 'https://example.com/login', source: 'browser-env' });

    const callback = await request(app)
      .post(`/api/auth-requests/${create.body.id}/callback`)
      .send({ url: 'http://localhost:49152/callback?code=abc' });

    expect(callback.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:49152/callback?code=abc', expect.objectContaining({ method: 'GET' }));
    expect(callback.body.status).toBe('callback_forwarded');
  });

  it('does not follow redirects when forwarding loopback callback URLs', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 302, text: async () => '' });
    service = new AuthRequestService(broadcaster, { fetch: fetchMock as any });
    app = express();
    app.use(express.json());
    app.use('/api/auth-requests', createAuthRouter(service));

    const create = await request(app)
      .post('/api/auth-requests')
      .send({ url: 'https://example.com/login', source: 'browser-env' });

    const callback = await request(app)
      .post(`/api/auth-requests/${create.body.id}/callback`)
      .send({ url: 'http://localhost:49152/callback?code=abc' });

    expect(callback.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:49152/callback?code=abc', expect.objectContaining({ redirect: 'manual' }));
  });

  it('caps listed auth requests to the 100 newest records', async () => {
    const createdIds: string[] = [];
    for (let index = 0; index < 105; index++) {
      const res = await request(app)
        .post('/api/auth-requests')
        .send({ url: `https://example.com/login/${index}`, source: 'browser-env' });
      createdIds.push(res.body.id);
    }

    const list = await request(app).get('/api/auth-requests');

    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(100);
    expect(list.body[0].id).toBe(createdIds[104]);
    expect(list.body.map((record: { id: string }) => record.id)).not.toContain(createdIds[0]);
  });
});
