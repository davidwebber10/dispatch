import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/connection.js';
import * as pushDb from '../db/push.js';
import { PushService } from '../push/service.js';
import { createPushRouter } from './push.js';

let dir: string;
let db: Database.Database;

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/push', createPushRouter(new PushService(db, { vapidDir: dir, send: async () => {} })));
  return a;
}
const sub = (endpoint: string) => ({ deviceId: 'dev1', subscription: { endpoint, keys: { p256dh: 'k', auth: 'a' } } });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-push-route-'));
  db = createDatabase(path.join(dir, 'test.db'));
});
afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('POST /api/push/subscribe', () => {
  it('stores a subscription from a known push service', async () => {
    const res = await request(app()).post('/api/push/subscribe').send(sub('https://web.push.apple.com/abc'));
    expect(res.status).toBe(200);
    expect(pushDb.list(db).map((s) => s.endpoint)).toEqual(['https://web.push.apple.com/abc']);
  });

  it.each([
    'https://attacker.example/collect',
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com.attacker.example/x',
    'https://127.0.0.1:3456/api/sessions',
  ])('refuses %s with a clean 400 and stores nothing', async (endpoint) => {
    const res = await request(app()).post('/api/push/subscribe').send(sub(endpoint));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/supported push service/);
    expect(JSON.stringify(res.body)).not.toContain(endpoint);
    expect(pushDb.list(db)).toEqual([]);
  });

  it('refuses a replacement endpoint on an existing device and keeps the old one', async () => {
    await request(app()).post('/api/push/subscribe').send(sub('https://web.push.apple.com/abc'));
    const res = await request(app()).post('/api/push/subscribe').send(sub('https://attacker.example/x'));
    expect(res.status).toBe(400);
    expect(pushDb.list(db).map((s) => s.endpoint)).toEqual(['https://web.push.apple.com/abc']);
  });
});
