import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as pushDb from '../../src/db/push.js';

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

import { PushService } from '../../src/push/service.js';
import fs from 'fs'; import os from 'os'; import path from 'path';

describe('PushService', () => {
  let d: Database.Database; let vapidDir: string; let sent: { sub: any; payload: string }[];
  function svc() {
    d = db(); vapidDir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
    sent = [];
    const s = new PushService(d, { vapidDir, send: async (sub, payload) => { sent.push({ sub, payload }); } });
    return s;
  }
  it('generates+persists a VAPID public key (stable across instances)', () => {
    const s = svc(); const k1 = s.getPublicKey();
    expect(k1).toBeTruthy();
    const s2 = new PushService(d, { vapidDir, send: async () => {} });
    expect(s2.getPublicKey()).toBe(k1);
  });
  it('notifyThread skips only a foreground device viewing this thread', async () => {
    const s = svc();
    s.subscribe('dev-fg', { endpoint: 'https://e/fg', keys: { p256dh: 'k', auth: 'a' } });
    s.subscribe('dev-bg', { endpoint: 'https://e/bg', keys: { p256dh: 'k', auth: 'a' } });
    s.setPresence('dev-fg', true, 't1'); // foreground + viewing this thread → suppressed
    s.setPresence('dev-bg', false);      // away → notified
    await s.notifyThread({ terminalId: 't1', sessionId: 's1', title: 'Proj', body: 'Thread finished' });
    expect(sent.map((x) => x.sub.endpoint)).toEqual(['https://e/bg']);
  });
  it('prunes a subscription whose send throws a 410', async () => {
    d = db(); vapidDir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
    const s = new PushService(d, { vapidDir, send: async () => { const e: any = new Error('gone'); e.statusCode = 410; throw e; } });
    s.subscribe('dev', { endpoint: 'https://e/x', keys: { p256dh: 'k', auth: 'a' } });
    await s.notifyThread({ terminalId: 't1', sessionId: 's1', title: 'P', body: 'done' });
    expect((await import('../../src/db/push.js')).list(d)).toEqual([]);
  });
  it('prunes a subscription whose send throws a 404', async () => {
    d = db(); vapidDir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
    const s = new PushService(d, { vapidDir, send: async () => { const e: any = new Error('not found'); e.statusCode = 404; throw e; } });
    s.subscribe('dev', { endpoint: 'https://e/y', keys: { p256dh: 'k', auth: 'a' } });
    await s.notifyThread({ terminalId: 't1', sessionId: 's1', title: 'P', body: 'done' });
    expect((await import('../../src/db/push.js')).list(d)).toEqual([]);
  });
  it('notifies a device that has never reported presence (missing presence ⇒ not viewing)', async () => {
    // covers the "!p" branch in isViewing(); stale-presence shares the same notify path
    const s = svc();
    s.subscribe('dev-unknown', { endpoint: 'https://e/unknown', keys: { p256dh: 'k', auth: 'a' } });
    // no setPresence call → treated as not viewing → should be notified
    await s.notifyThread({ terminalId: 't1', sessionId: 's1', title: 'P', body: 'done' });
    expect(sent.map((x) => x.sub.endpoint)).toContain('https://e/unknown');
  });
});
