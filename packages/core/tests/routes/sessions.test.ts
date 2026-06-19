import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';

describe('session routes', () => {
  let app: any;

  beforeEach(() => {
    const db = new Database(':memory:');
    initSchema(db);
    app = createApp({ db, skipPty: true });
  });

  it('POST /api/sessions creates a session', async () => {
    const res = await request(app)
      .post('/api/sessions')
      .send({ provider: 'claude-code', workingDir: '/tmp/test', name: 'test' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('test');
    expect(res.body.provider).toBe('claude-code');
  });

  it('GET /api/sessions lists sessions', async () => {
    await request(app).post('/api/sessions').send({ provider: 'claude-code', workingDir: '/tmp', name: 'a' });
    const res = await request(app).get('/api/sessions');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('PATCH /api/sessions/:id updates fields', async () => {
    const create = await request(app).post('/api/sessions').send({ provider: 'claude-code', workingDir: '/tmp', name: 'old' });
    const res = await request(app).patch(`/api/sessions/${create.body.id}`).send({ name: 'new' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('new');
  });

  it('DELETE /api/sessions/:id archives', async () => {
    const create = await request(app).post('/api/sessions').send({ provider: 'claude-code', workingDir: '/tmp', name: 'x' });
    const res = await request(app).delete(`/api/sessions/${create.body.id}`);
    expect(res.status).toBe(204);
    const list = await request(app).get('/api/sessions');
    expect(list.body).toHaveLength(0);
  });
});
