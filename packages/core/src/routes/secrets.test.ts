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
