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

  it('POST / rejects a typed-in secret with 400 and says to use a ${NAME} reference when references can resolve (SEC-17)', async () => {
    const express = (await import('express')).default;
    const { createIntegrationsRouter } = await import('../../src/routes/integrations.js');
    const { IntegrationsService } = await import('../../src/integrations/service.js');
    const d = new Database(':memory:'); initSchema(d);
    const mini = express();
    mini.use(express.json());
    mini.use('/api/integrations', createIntegrationsRouter(new IntegrationsService(d, null, () => true)));
    const res = await request(mini).post('/api/integrations').send({ type: 'remote', name: 'linear', url: 'https://mcp.linear.app/sse', headers: { Authorization: 'Bearer abc' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Authorization.*\$\{MY_API_TOKEN\}/);
    expect((await request(mini).get('/api/integrations')).body.integrations).toEqual([]);
    const ok = await request(mini).post('/api/integrations').send({ type: 'remote', name: 'linear', url: 'https://mcp.linear.app/sse', headers: { Authorization: 'Bearer ${LINEAR_TOKEN}' } });
    expect(ok.status).toBe(200);
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
    expect(imp.body).toEqual({ added: ['linear'], skipped: [], reasons: [] });
  });
});

// W1-B: the export carries every header and env value, so it is strict. A local call with no credential must look like the web page.
describe('GET /api/integrations/export is strict owner', () => {
  const TOKEN = 'owner-access-token-for-the-integrations-test-0123456789';
  async function gated() {
    const express = (await import('express')).default;
    const { createIntegrationsRouter } = await import('../../src/routes/integrations.js');
    const { IntegrationsService } = await import('../../src/integrations/service.js');
    const { createPrincipalMiddleware } = await import('../../src/auth/request-principal.js');
    const { createKeyScope } = await import('../../src/auth/key-scope.js');
    const { KeyRegistry } = await import('../../src/auth/principals.js');
    const { GATE_VIA } = await import('../../src/auth/access-gate.js');
    const { configureRefusalLog } = await import('../../src/auth/route-policy.js');
    const integrationsDb = await import('../../src/db/integrations.js');
    configureRefusalLog({ log: () => {} });
    const d = new Database(':memory:'); initSchema(d);
    integrationsDb.create(d, { id: 'i1', name: 'files', type: 'stdio', command: 'npx', env: { DB_PASSWORD: 'hunter2' } });
    const g = express();
    g.use((req: any, _res: any, next: any) => { req[GATE_VIA] = 'local'; next(); });
    g.use(createPrincipalMiddleware({ registry: new KeyRegistry(), scope: createKeyScope(d), getToken: () => TOKEN, via: 'test' }));
    g.use(express.json());
    g.use('/api/integrations', createIntegrationsRouter(new IntegrationsService(d, null, () => false)));
    return g;
  }

  it('a call with no credential and no browser headers answers 401 auth_required', async () => {
    const res = await request(await gated()).get('/api/integrations/export');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('auth_required');
    expect(res.text).not.toContain('hunter2');
  });

  it('the web page (browser headers) gets the value', async () => {
    const g = await gated();
    const meta = await request(g).get('/api/integrations/export').set('Sec-Fetch-Site', 'same-origin');
    expect(meta.status).toBe(200);
    expect(meta.text).toContain('hunter2');
    // A page on plain http (a tailnet name) sends no Sec-Fetch-Site and no Origin on a GET; its Referer names the page.
    const plain = await request(g).get('/api/integrations/export').set('Host', 'mac.tail1.ts.net:3456').set('Referer', 'http://mac.tail1.ts.net:3456/');
    expect(plain.status).toBe(200);
    expect(plain.text).toContain('hunter2');
  });

  it('a bearer token gets the value', async () => {
    const res = await request(await gated()).get('/api/integrations/export').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('hunter2');
  });
});

// Integration: the list masked nothing for a local caller with no credential, so any local program read every env
// value (W1-B finding). It now gets the masked list; the web page and the owner token still see the values.
describe('GET /api/integrations masks values for a local program with no credential', () => {
  const TOKEN = 'owner-access-token-for-the-integrations-list-test-0123456';
  async function gated() {
    const express = (await import('express')).default;
    const { createIntegrationsRouter } = await import('../../src/routes/integrations.js');
    const { IntegrationsService } = await import('../../src/integrations/service.js');
    const { createPrincipalMiddleware } = await import('../../src/auth/request-principal.js');
    const { createKeyScope } = await import('../../src/auth/key-scope.js');
    const { KeyRegistry } = await import('../../src/auth/principals.js');
    const { GATE_VIA } = await import('../../src/auth/access-gate.js');
    const integrationsDb = await import('../../src/db/integrations.js');
    const d = new Database(':memory:'); initSchema(d);
    integrationsDb.create(d, { id: 'i1', name: 'files', type: 'stdio', command: 'npx', env: { DB_PASSWORD: 'hunter2' } });
    const g = express();
    g.use((req: any, _res: any, next: any) => { req[GATE_VIA] = 'local'; next(); });
    g.use(createPrincipalMiddleware({ registry: new KeyRegistry(), scope: createKeyScope(d), getToken: () => TOKEN, via: 'test' }));
    g.use(express.json());
    g.use('/api/integrations', createIntegrationsRouter(new IntegrationsService(d, null, () => false)));
    return g;
  }

  it('a local program with no credential and no browser headers gets the list with masked values', async () => {
    const res = await request(await gated()).get('/api/integrations');
    expect(res.status).toBe(200);
    expect(res.body.integrations).toHaveLength(1);
    expect(res.text).not.toContain('hunter2');
  });

  it('the web page and the owner token still get the values', async () => {
    const g = await gated();
    const page = await request(g).get('/api/integrations').set('Sec-Fetch-Site', 'same-origin');
    expect(page.text).toContain('hunter2');
    const plain = await request(g).get('/api/integrations').set('Host', 'mac.tail1.ts.net:3456').set('Referer', 'http://mac.tail1.ts.net:3456/');
    expect(plain.text).toContain('hunter2');
    const owner = await request(g).get('/api/integrations').set('Authorization', `Bearer ${TOKEN}`);
    expect(owner.text).toContain('hunter2');
  });
});
