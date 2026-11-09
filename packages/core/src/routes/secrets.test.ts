import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { SecretsService } from '../secrets/service.js';
import { createSecretsRouter } from './secrets.js';

const calls: Array<[string, string]> = [];
function fakeClient() {
  return {
    verify: async () => true,
    listProjects: async () => [],
    listConfigs: async () => [],
    listSecrets: async (p: string, c: string) => { calls.push([p, c]); return [{ name: 'A_KEY', value: 'sekret-a' }, { name: 'B_KEY', value: 'sekret-b' }]; },
    getSecret: async (_p: string, _c: string, name: string) => (name === 'A_KEY' ? 'sekret-a' : null),
    setSecret: async () => {},
    deleteSecret: async () => {},
  } as any;
}

let dir: string;
let app: express.Express;
beforeEach(async () => {
  calls.length = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-secroute-'));
  const svc = new SecretsService(dir, () => fakeClient());
  await svc.setConnection({ token: 't', project: 'proj', config: 'dev', enabled: true, readOnly: false });
  app = express();
  app.use(express.json());
  app.use('/api/secrets', createSecretsRouter(svc));
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('secrets route returns names only', () => {
  it('GET / has no values anywhere in the body', async () => {
    const res = await request(app).get('/api/secrets');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ name: 'A_KEY' }, { name: 'B_KEY' }]);
    expect(res.text).not.toContain('sekret');
  });

  it('refuses a project or config other than the configured pair', async () => {
    const res = await request(app).get('/api/secrets?project=other&config=prd');
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('accepts the configured pair', async () => {
    const res = await request(app).get('/api/secrets?project=proj&config=dev');
    expect(res.status).toBe(200);
  });
});

describe('GET /:name/value', () => {
  it('requires the explicit reveal header', async () => {
    const res = await request(app).get('/api/secrets/A_KEY/value');
    expect(res.status).toBe(400);
    expect(res.text).not.toContain('sekret');
  });

  it('returns one value, uncached, with the header', async () => {
    const res = await request(app).get('/api/secrets/A_KEY/value').set('X-Dispatch-Reveal', '1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ value: 'sekret-a' });
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  it('404s an unknown name', async () => {
    const res = await request(app).get('/api/secrets/NOPE/value').set('X-Dispatch-Reveal', '1');
    expect(res.status).toBe(404);
  });
});

// W1-B: the value route is strict. A local call with no credential must look like the web page.
describe('GET /:name/value is strict owner', () => {
  const TOKEN = 'owner-access-token-for-the-secrets-test-0123456789';
  async function gated() {
    const Database = (await import('better-sqlite3')).default;
    const { initSchema } = await import('../db/schema.js');
    const { createPrincipalMiddleware } = await import('../auth/request-principal.js');
    const { createKeyScope } = await import('../auth/key-scope.js');
    const { KeyRegistry } = await import('../auth/principals.js');
    const { GATE_VIA } = await import('../auth/access-gate.js');
    const { configureRefusalLog } = await import('../auth/route-policy.js');
    configureRefusalLog({ log: () => {} });
    const db = new Database(':memory:'); initSchema(db);
    const svc = new SecretsService(dir, () => fakeClient());
    const g = express();
    g.use((req, _res, next) => { (req as any)[GATE_VIA] = 'local'; next(); });
    g.use(createPrincipalMiddleware({ registry: new KeyRegistry(), scope: createKeyScope(db), getToken: () => TOKEN, via: 'test' }));
    g.use(express.json());
    g.use('/api/secrets', createSecretsRouter(svc));
    return g;
  }
  const value = (g: express.Express) => request(g).get('/api/secrets/A_KEY/value').set('X-Dispatch-Reveal', '1');

  it('a call with no credential and no browser headers answers 401 auth_required', async () => {
    const res = await value(await gated());
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('auth_required');
    expect(res.text).not.toContain('sekret');
  });

  it('the web page (browser headers) gets the value', async () => {
    const g = await gated();
    for (const [h, v] of [['Sec-Fetch-Site', 'same-origin'], ['Origin', 'http://localhost:3456']] as const) {
      const res = await value(g).set(h, v);
      expect(res.status, h).toBe(200);
      expect(res.body).toEqual({ value: 'sekret-a' });
    }
    // A page on plain http (a tailnet name) sends neither header on a GET; its Referer names the page.
    const plain = await value(g).set('Host', 'mac.tail1.ts.net:3456').set('Referer', 'http://mac.tail1.ts.net:3456/');
    expect(plain.status).toBe(200);
    expect(plain.body).toEqual({ value: 'sekret-a' });
  });

  it('a bearer token gets the value', async () => {
    const res = await value(await gated()).set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ value: 'sekret-a' });
  });

  it('the list of names stays open to a local call with no credential (only the value is strict)', async () => {
    const res = await request(await gated()).get('/api/secrets');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ name: 'A_KEY' }, { name: 'B_KEY' }]);
  });
});
