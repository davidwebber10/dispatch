import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { createApp } from '../../src/server.js';
import { initSchema } from '../../src/db/schema.js';
import { SecretsService } from '../../src/secrets/service.js';

let dir: string;
let app: ReturnType<typeof createApp>;
let client: any;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-secrets-routes-'));
  const mcp = path.join(dir, 'mcp.js');
  fs.writeFileSync(mcp, '//');
  client = {
    verify: vi.fn(async () => true),
    listProjects: vi.fn(async () => [{ id: 'p1', slug: 'dispatch', name: 'Dispatch' }]),
    listConfigs: vi.fn(async () => [{ name: 'dev', environment: 'dev' }]),
    listSecrets: vi.fn(async () => [{ name: 'API_KEY', value: 'xyz' }]),
    getSecret: vi.fn(),
    setSecret: vi.fn(async () => {}),
    deleteSecret: vi.fn(async () => {}),
  };
  delete process.env.DOPPLER_TOKEN;
  const secretsService = new SecretsService(dir, () => client, mcp);
  const db = new Database(':memory:');
  initSchema(db);
  app = createApp({ db, skipPty: true, secretsService });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe('secrets routes', () => {
  it('GET /status starts disconnected and never returns a token', async () => {
    const r = await request(app).get('/api/secrets/status').expect(200);
    expect(r.body.connected).toBe(false);
    expect(r.body.token).toBeUndefined();
  });

  it('connect (token) then set project/config -> connected; GET / lists secrets', async () => {
    await request(app).put('/api/secrets/connection').send({ token: 'dp.sa.x' }).expect(200);
    await request(app).put('/api/secrets/connection').send({ token: '', project: 'dispatch', config: 'dev' }).expect(200);
    expect((await request(app).get('/api/secrets/status').expect(200)).body.connected).toBe(true);
    const list = await request(app).get('/api/secrets').expect(200);
    expect(list.body).toEqual([{ name: 'API_KEY', value: 'xyz' }]);
  });

  it('POST / upserts (204) and requires a name (400)', async () => {
    await request(app).put('/api/secrets/connection').send({ token: 'dp.sa.x', project: 'dispatch', config: 'dev' }).expect(200);
    await request(app).post('/api/secrets').send({ name: 'A', value: 'b' }).expect(204);
    expect(client.setSecret).toHaveBeenCalledWith('dispatch', 'dev', 'A', 'b');
    await request(app).post('/api/secrets').send({ value: 'b' }).expect(400);
  });

  it('DELETE /:name (204), and DELETE /connection disconnects (not treated as a secret name)', async () => {
    await request(app).put('/api/secrets/connection').send({ token: 'dp.sa.x', project: 'dispatch', config: 'dev' }).expect(200);
    await request(app).delete('/api/secrets/A').expect(204);
    expect(client.deleteSecret).toHaveBeenCalledWith('dispatch', 'dev', 'A');
    await request(app).delete('/api/secrets/connection').expect(200);
    expect((await request(app).get('/api/secrets/status').expect(200)).body.connected).toBe(false);
  });

  it('rejects an invalid token with 400', async () => {
    client.verify = vi.fn(async () => false);
    await request(app).put('/api/secrets/connection').send({ token: 'bad' }).expect(400);
  });

  it('GET /projects proxies the client', async () => {
    await request(app).put('/api/secrets/connection').send({ token: 'dp.sa.x' }).expect(200);
    const r = await request(app).get('/api/secrets/projects').expect(200);
    expect(r.body).toEqual([{ id: 'p1', slug: 'dispatch', name: 'Dispatch' }]);
  });
});
