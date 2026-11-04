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
  delete process.env.DISPATCH_MAX_PUSH_SUBSCRIPTIONS;
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

const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

describe('GET /api/push/subscriptions and DELETE /api/push/subscriptions/:deviceId', () => {
  it('lists label, host, created and last sent, and never the push address or keys', async () => {
    const a = app();
    await request(a).post('/api/push/subscribe').set('User-Agent', UA_IPHONE).send(sub('https://web.push.apple.com/secret-path-123'));
    const res = await request(a).get('/api/push/subscriptions');
    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(1);
    const row = res.body.subscriptions[0];
    expect(row).toMatchObject({ deviceId: 'dev1', label: 'iPhone · Safari', host: 'web.push.apple.com', lastSentAt: null });
    expect(typeof row.createdAt).toBe('string');
    expect(JSON.stringify(res.body)).not.toContain('secret-path-123');
    expect(JSON.stringify(res.body)).not.toContain('p256dh');
  });

  it('shows the last sent time after a notification goes out', async () => {
    const svc = new PushService(db, { vapidDir: dir, send: async () => {} });
    const a = express();
    a.use(express.json());
    a.use('/api/push', createPushRouter(svc));
    await request(a).post('/api/push/subscribe').send(sub('https://web.push.apple.com/abc'));
    await svc.notifyThread({ terminalId: 't', sessionId: 's', title: 'x', body: 'y' });
    const res = await request(a).get('/api/push/subscriptions');
    expect(res.body.subscriptions[0].lastSentAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('revokes one subscription and leaves the others', async () => {
    const a = app();
    await request(a).post('/api/push/subscribe').send({ ...sub('https://web.push.apple.com/a'), deviceId: 'one' });
    await request(a).post('/api/push/subscribe').send({ ...sub('https://fcm.googleapis.com/fcm/send/b'), deviceId: 'two' });
    const del = await request(a).delete('/api/push/subscriptions/one');
    expect(del.status).toBe(200);
    expect(pushDb.list(db).map((s) => s.deviceId)).toEqual(['two']);
  });

  it('answers 404 for a subscription that is not stored', async () => {
    const res = await request(app()).delete('/api/push/subscriptions/nope');
    expect(res.status).toBe(404);
  });
});

describe('the stored subscription cap (SEC-23)', () => {
  it('refuses a new device past DISPATCH_MAX_PUSH_SUBSCRIPTIONS with a clear 429, and still lets a known device refresh', async () => {
    process.env.DISPATCH_MAX_PUSH_SUBSCRIPTIONS = '2';
    const a = app();
    for (const id of ['d1', 'd2']) {
      expect((await request(a).post('/api/push/subscribe').send({ ...sub(`https://web.push.apple.com/${id}`), deviceId: id })).status).toBe(200);
    }
    const over = await request(a).post('/api/push/subscribe').send({ ...sub('https://web.push.apple.com/d3'), deviceId: 'd3' });
    expect(over.status).toBe(429);
    expect(over.body.error).toMatch(/2 push subscriptions/);
    expect(over.body.error).toMatch(/DISPATCH_MAX_PUSH_SUBSCRIPTIONS/);
    expect(pushDb.list(db).map((s) => s.deviceId).sort()).toEqual(['d1', 'd2']);
    const refresh = await request(a).post('/api/push/subscribe').send({ ...sub('https://web.push.apple.com/d1-new'), deviceId: 'd1' });
    expect(refresh.status).toBe(200);
  });

  it('frees a slot when the owner revokes one', async () => {
    process.env.DISPATCH_MAX_PUSH_SUBSCRIPTIONS = '1';
    const a = app();
    await request(a).post('/api/push/subscribe').send({ ...sub('https://web.push.apple.com/d1'), deviceId: 'd1' });
    await request(a).delete('/api/push/subscriptions/d1');
    expect((await request(a).post('/api/push/subscribe').send({ ...sub('https://web.push.apple.com/d2'), deviceId: 'd2' })).status).toBe(200);
  });

  it('0 turns the cap off', async () => {
    process.env.DISPATCH_MAX_PUSH_SUBSCRIPTIONS = '0';
    const a = app();
    for (let i = 0; i < 60; i++) {
      expect((await request(a).post('/api/push/subscribe').send({ ...sub(`https://web.push.apple.com/${i}`), deviceId: `d${i}` })).status).toBe(200);
    }
  });
});

describe('a browser that cleared its storage (new device id, same push address)', () => {
  it('keeps one row and gets each alert once', async () => {
    const sent: string[] = [];
    const svc = new PushService(db, { vapidDir: dir, send: async (sub) => { sent.push(sub.deviceId); } });
    const a = express();
    a.use(express.json());
    a.use('/api/push', createPushRouter(svc));
    await request(a).post('/api/push/subscribe').send({ ...sub('https://web.push.apple.com/same'), deviceId: 'before' });
    await request(a).post('/api/push/subscribe').send({ ...sub('https://web.push.apple.com/same'), deviceId: 'after' });
    expect(pushDb.list(db).map((s) => s.deviceId)).toEqual(['after']);
    await svc.notifyThread({ terminalId: 't', sessionId: 's', title: 'x', body: 'y' });
    expect(sent).toEqual(['after']);
  });

  it('is allowed at the cap, because it replaces a row and adds none', async () => {
    process.env.DISPATCH_MAX_PUSH_SUBSCRIPTIONS = '1';
    const a = app();
    await request(a).post('/api/push/subscribe').send({ ...sub('https://web.push.apple.com/same'), deviceId: 'before' });
    const again = await request(a).post('/api/push/subscribe').send({ ...sub('https://web.push.apple.com/same'), deviceId: 'after' });
    expect(again.status).toBe(200);
    const other = await request(a).post('/api/push/subscribe').send({ ...sub('https://web.push.apple.com/different'), deviceId: 'third' });
    expect(other.status).toBe(429);
  });
});

