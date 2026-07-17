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
});
