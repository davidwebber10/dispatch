import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';

describe('integrations routes', () => {
  let app: any;
  beforeEach(() => { const db = new Database(':memory:'); initSchema(db); app = createApp({ db, skipPty: true }); });

  it('GET / returns an empty catalog initially', async () => {
    const res = await request(app).get('/api/integrations');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ integrations: [] });
  });

  it('POST / adds a remote integration and GET / lists it', async () => {
    const post = await request(app).post('/api/integrations').send({ type: 'remote', name: 'linear', url: 'https://mcp.linear.app/sse' });
    expect(post.status).toBe(200);
    expect(post.body).toMatchObject({ name: 'linear', type: 'remote', enabled: true });
    const list = await request(app).get('/api/integrations');
    expect(list.body.integrations.map((i: any) => i.name)).toEqual(['linear']);
  });

  it('POST / rejects a bad name with 400', async () => {
    const res = await request(app).post('/api/integrations').send({ type: 'remote', name: 'bad name', url: 'https://x' });
    expect(res.status).toBe(400);
  });

  it('POST / rejects a duplicate name with 409', async () => {
    await request(app).post('/api/integrations').send({ type: 'stdio', name: 'fs', command: 'x' });
    const res = await request(app).post('/api/integrations').send({ type: 'stdio', name: 'fs', command: 'y' });
    expect(res.status).toBe(409);
  });

  it('PATCH /:id toggles enabled', async () => {
    const post = await request(app).post('/api/integrations').send({ type: 'stdio', name: 'fs', command: 'x' });
    const res = await request(app).patch(`/api/integrations/${post.body.id}`).send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });

  it('PATCH /:id returns 404 for a missing id', async () => {
    const res = await request(app).patch('/api/integrations/nope').send({ enabled: false });
    expect(res.status).toBe(404);
  });

  it('DELETE /:id removes', async () => {
    const post = await request(app).post('/api/integrations').send({ type: 'stdio', name: 'fs', command: 'x' });
    const res = await request(app).delete(`/api/integrations/${post.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: true });
  });

  it('PATCH /:id rejects a non-boolean enabled with 400', async () => {
    const post = await request(app).post('/api/integrations').send({ type: 'stdio', name: 'fs', command: 'x' });
    const res = await request(app).patch(`/api/integrations/${post.body.id}`).send({ enabled: 'yes' });
    expect(res.status).toBe(400);
  });

  it('POST /import rejects an invalid body with 400', async () => {
    const res = await request(app).post('/api/integrations/import').send({ integrations: 'nope' });
    expect(res.status).toBe(400);
  });

  it('GET /export responds 200 with a versioned doc', async () => {
    const res = await request(app).get('/api/integrations/export');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: 1, integrations: [] });
  });

  it('export then import round-trips into a fresh app', async () => {
    await request(app).post('/api/integrations').send({ type: 'remote', name: 'linear', url: 'https://mcp.linear.app/sse' });
    const exp = await request(app).get('/api/integrations/export');
    expect(exp.body.version).toBe(1);
    const db2 = new Database(':memory:'); initSchema(db2); const app2 = createApp({ db: db2, skipPty: true });
    const imp = await request(app2).post('/api/integrations/import').send(exp.body);
    expect(imp.body).toEqual({ added: ['linear'], skipped: [] });
  });
});
