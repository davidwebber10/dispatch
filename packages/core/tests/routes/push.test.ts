import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';

describe('push routes', () => {
  let app: any; let dir: string;
  beforeEach(() => { const db = new Database(':memory:'); initSchema(db); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-rt-')); app = createApp({ db, skipPty: true, secretsDir: dir }); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ } });
  it('GET /key returns a public key', async () => {
    const res = await request(app).get('/api/push/key');
    expect(res.status).toBe(200);
    expect(typeof res.body.publicKey).toBe('string');
    expect(res.body.publicKey.length).toBeGreaterThan(0);
  });
  it('subscribe → unsubscribe and presence are accepted', async () => {
    const sub = { endpoint: 'https://e/1', keys: { p256dh: 'k', auth: 'a' } };
    expect((await request(app).post('/api/push/subscribe').send({ deviceId: 'd1', subscription: sub })).status).toBe(200);
    expect((await request(app).post('/api/push/presence').send({ deviceId: 'd1', foreground: true })).status).toBe(200);
    expect((await request(app).post('/api/push/unsubscribe').send({ deviceId: 'd1' })).status).toBe(200);
  });
  it('subscribe rejects a malformed body with 400', async () => {
    expect((await request(app).post('/api/push/subscribe').send({ deviceId: 'd1' })).status).toBe(400);
  });
});
