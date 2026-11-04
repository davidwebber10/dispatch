import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from './schema.js';
import * as pushDb from './push.js';

function db() { const d = new Database(':memory:'); initSchema(d); return d; }

describe('push db', () => {
  let d: Database.Database;
  beforeEach(() => { d = db(); });

  it('upserts by device_id and lists', () => {
    pushDb.upsert(d, { deviceId: 'dev1', endpoint: 'https://e/1', p256dh: 'k', auth: 'a' });
    pushDb.upsert(d, { deviceId: 'dev1', endpoint: 'https://e/1b', p256dh: 'k2', auth: 'a2' }); // same device → replace
    pushDb.upsert(d, { deviceId: 'dev2', endpoint: 'https://e/2', p256dh: 'k', auth: 'a' });
    const all = pushDb.list(d);
    expect(all.length).toBe(2);
    expect(all.find((s) => s.deviceId === 'dev1')!.endpoint).toBe('https://e/1b');
  });

  it('removes by deviceId and by endpoint', () => {
    pushDb.upsert(d, { deviceId: 'dev1', endpoint: 'https://e/1', p256dh: 'k', auth: 'a' });
    pushDb.remove(d, 'dev1');
    expect(pushDb.list(d)).toEqual([]);
    pushDb.upsert(d, { deviceId: 'dev2', endpoint: 'https://e/2', p256dh: 'k', auth: 'a' });
    pushDb.removeByEndpoint(d, 'https://e/2');
    expect(pushDb.list(d)).toEqual([]);
  });

  it('keeps label and last-sent: a refresh without a label keeps the old one; markSent stamps', () => {
    pushDb.upsert(d, { deviceId: 'dev1', endpoint: 'https://e/1', p256dh: 'k', auth: 'a', label: 'iPhone · Safari' });
    pushDb.upsert(d, { deviceId: 'dev1', endpoint: 'https://e/1b', p256dh: 'k', auth: 'a' });
    expect(pushDb.listInfo(d)[0]).toMatchObject({ deviceId: 'dev1', label: 'iPhone · Safari', lastSentAt: null });
    pushDb.markSent(d, 'dev1');
    expect(pushDb.listInfo(d)[0].lastSentAt).toMatch(/^\d{4}-/);
    expect(pushDb.count(d)).toBe(1);
    expect(pushDb.has(d, 'dev1')).toBe(true);
    expect(pushDb.remove(d, 'dev1')).toBe(true);
    expect(pushDb.remove(d, 'dev1')).toBe(false);
  });

  it('adds the columns to a table made before the push list existed (migration 015)', () => {
    const old = new Database(':memory:');
    old.exec(`CREATE TABLE push_subscriptions (device_id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO push_subscriptions VALUES ('old','https://e/old','k','a','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');`);
    initSchema(old);
    expect(pushDb.listInfo(old)).toEqual([{ deviceId: 'old', endpoint: 'https://e/old', label: null, createdAt: '2026-01-01T00:00:00.000Z', lastSentAt: null }]);
  });
});
