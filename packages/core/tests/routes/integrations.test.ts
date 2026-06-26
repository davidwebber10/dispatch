import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';
import { createIntegrationsRouter } from '../../src/routes/integrations.js';

describe('integrations routes', () => {
  let app: any;
  beforeEach(() => { const db = new Database(':memory:'); initSchema(db); app = createApp({ db, skipPty: true }); });
  it('GET /api/integrations/status returns the installed shape', async () => {
    const res = await request(app).get('/api/integrations/status');
    expect(res.status).toBe(200);
    expect(typeof res.body.installed).toBe('boolean');
    expect(res.body.version === null || typeof res.body.version === 'string').toBe(true);
  });
});

// Mount the router directly with a fake service to test list/add/remove in isolation.
function appWith(overrides: Record<string, any> = {}) {
  const svc: any = {
    status: () => ({ installed: true, version: '1.5.20' }),
    list: async () => [{ slug: 'petstore', description: 'P', kind: 'openapi', canRemove: true, canRefresh: true }],
    add: async (_input: any) => ({ slug: 'new-one', toolCount: 2 }),
    remove: async (_slug: string) => ({ removed: true }),
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  app.use('/api/integrations', createIntegrationsRouter(svc));
  return app;
}

describe('integrations management routes', () => {
  it('GET / returns installed + the integration list', async () => {
    const res = await request(appWith()).get('/api/integrations');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ installed: true, integrations: [{ slug: 'petstore', description: 'P', kind: 'openapi', canRemove: true, canRefresh: true }] });
  });

  it('GET / short-circuits to empty when executor is not installed (list never called)', async () => {
    let listed = false;
    const res = await request(appWith({ status: () => ({ installed: false, version: null }), list: async () => { listed = true; return []; } })).get('/api/integrations');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ installed: false, integrations: [] });
    expect(listed).toBe(false);
  });

  it('GET / returns 502 when list throws', async () => {
    const res = await request(appWith({ list: async () => { throw new Error('daemon down'); } })).get('/api/integrations');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Could not reach the executor catalog.');
  });

  it('POST / adds a valid openapi source', async () => {
    const res = await request(appWith()).post('/api/integrations').send({ type: 'openapi', url: 'https://x/openapi.json', slug: 'my-api' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ slug: 'new-one', toolCount: 2 });
  });

  it('POST / rejects an unknown type with 400', async () => {
    const res = await request(appWith()).post('/api/integrations').send({ type: 'cli', command: 'git' });
    expect(res.status).toBe(400);
  });

  it('POST / rejects openapi missing slug with 400', async () => {
    const res = await request(appWith()).post('/api/integrations').send({ type: 'openapi', url: 'https://x' });
    expect(res.status).toBe(400);
  });

  it('POST / returns 409 when executor is not installed', async () => {
    const res = await request(appWith({ status: () => ({ installed: false, version: null }) })).post('/api/integrations').send({ type: 'openapi', url: 'https://x', slug: 's' });
    expect(res.status).toBe(409);
  });

  it('DELETE /:slug removes an integration', async () => {
    const res = await request(appWith()).delete('/api/integrations/petstore');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: true });
  });

  it('DELETE /:slug returns 409 when executor is not installed', async () => {
    const res = await request(appWith({ status: () => ({ installed: false, version: null }) })).delete('/api/integrations/petstore');
    expect(res.status).toBe(409);
  });

  it('POST / returns 502 with a safe message when add throws', async () => {
    const res = await request(appWith({ add: async () => { throw new Error('secret-bearing network fail'); } }))
      .post('/api/integrations').send({ type: 'openapi', url: 'https://x', slug: 's' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Could not add the integration.');
  });

  it('DELETE /:slug returns 502 when remove throws', async () => {
    const res = await request(appWith({ remove: async () => { throw new Error('network fail'); } }))
      .delete('/api/integrations/petstore');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Could not remove the integration.');
  });

  it('POST / accepts a valid mcp-stdio source', async () => {
    const res = await request(appWith()).post('/api/integrations')
      .send({ type: 'mcp-stdio', name: 'My MCP', command: 'npx', args: ['-y', 'pkg'] });
    expect(res.status).toBe(200);
  });

  it('POST / rejects mcp-stdio with non-string args (400)', async () => {
    const res = await request(appWith()).post('/api/integrations')
      .send({ type: 'mcp-stdio', name: 'My MCP', command: 'npx', args: [1, 2] });
    expect(res.status).toBe(400);
  });

  it('POST / rejects an empty body (400)', async () => {
    const res = await request(appWith()).post('/api/integrations').send({});
    expect(res.status).toBe(400);
  });
});
