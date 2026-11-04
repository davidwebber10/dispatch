import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/connection.js';
import * as pushDb from '../db/push.js';
import { PushService, vapidSubject } from './service.js';

let dir: string;
let db: Database.Database;
let sent: { deviceId: string; payload: any }[];
let svc: PushService;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-push-'));
  db = createDatabase(path.join(dir, 'test.db'));
  sent = [];
  svc = new PushService(db, {
    vapidDir: dir,
    send: async (sub, payload) => { sent.push({ deviceId: sub.deviceId, payload: JSON.parse(payload) }); },
  });
  pushDb.upsert(db, { deviceId: 'phone', endpoint: 'https://fcm.googleapis.com/fcm/send/phone', p256dh: 'k', auth: 'a' });
  pushDb.upsert(db, { deviceId: 'desk', endpoint: 'https://web.push.apple.com/desk', p256dh: 'k', auth: 'a' });
});
afterEach(() => {
  vi.useRealTimers();
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const notify = () => svc.notifyThread({ terminalId: 't1', sessionId: 's1', title: 'Claude Code 37', body: 'Completed its task' });

describe('PushService presence rule — notify unless viewing it', () => {
  it('notifies devices that never reported presence', async () => {
    await notify();
    expect(sent.map((s) => s.deviceId).sort()).toEqual(['desk', 'phone']);
  });

  it('notifies a background device', async () => {
    svc.setPresence('phone', false, null);
    await notify();
    expect(sent.map((s) => s.deviceId).sort()).toEqual(['desk', 'phone']);
  });

  it('notifies a foreground device viewing a DIFFERENT thread', async () => {
    svc.setPresence('desk', true, 'other-thread');
    await notify();
    expect(sent.map((s) => s.deviceId).sort()).toEqual(['desk', 'phone']);
  });

  it('skips only the foreground device viewing THIS thread', async () => {
    svc.setPresence('desk', true, 't1');
    await notify();
    expect(sent.map((s) => s.deviceId)).toEqual(['phone']);
  });

  it('stops suppressing once presence goes stale (>90s)', async () => {
    vi.useFakeTimers();
    svc.setPresence('desk', true, 't1');
    vi.advanceTimersByTime(91_000);
    await notify();
    expect(sent.map((s) => s.deviceId).sort()).toEqual(['desk', 'phone']);
  });

  it('includes sessionId and terminalId in the payload (deep link data)', async () => {
    await notify();
    expect(sent[0].payload).toMatchObject({ terminalId: 't1', sessionId: 's1', title: 'Claude Code 37', body: 'Completed its task' });
  });

  it('keeps but never sends to a stored subscription whose host is not a push service', async () => {
    pushDb.upsert(db, { deviceId: 'old', endpoint: 'https://attacker.example/collect', p256dh: 'k', auth: 'a' });
    await notify();
    expect(sent.map((s) => s.deviceId).sort()).toEqual(['desk', 'phone']);
    expect(pushDb.list(db).map((s) => s.deviceId)).toContain('old');
  });

  it('prunes a subscription when the endpoint returns 410', async () => {
    svc = new PushService(db, {
      vapidDir: dir,
      send: async (sub) => { if (sub.deviceId === 'phone') { const e: any = new Error('gone'); e.statusCode = 410; throw e; } },
    });
    await notify();
    expect(pushDb.list(db).map((s) => s.deviceId)).toEqual(['desk']);
  });

  it('prunes a subscription when the endpoint returns 404', async () => {
    svc = new PushService(db, {
      vapidDir: dir,
      send: async (sub) => { if (sub.deviceId === 'phone') { const e: any = new Error('not found'); e.statusCode = 404; throw e; } },
    });
    await notify();
    expect(pushDb.list(db).map((s) => s.deviceId)).toEqual(['desk']);
  });
});

describe('PushService VAPID keys', () => {
  it('generates once and persists — stable across instances sharing a vapidDir', () => {
    const k1 = svc.getPublicKey();
    expect(k1).toBeTruthy();
    const again = new PushService(db, { vapidDir: dir, send: async () => {} });
    expect(again.getPublicKey()).toBe(k1);
  });
});

// Regression: the subject shipped as 'mailto:dispatch@localhost', which Apple's
// push service rejects with 403 BadJwtToken — every iOS notification failed
// silently (403 is not 404/410, so the subscription was never even pruned).
// Chrome/FCM accepts anything, which is why it went unnoticed.
describe('vapidSubject', () => {
  afterEach(() => { delete process.env.DISPATCH_VAPID_SUBJECT; });

  it('defaults to a routable subject Apple accepts — never localhost', () => {
    const s = vapidSubject();
    expect(s).not.toMatch(/localhost/);
    expect(s).toMatch(/^https:\/\/[^/\s]+\.[a-z]{2,}/i);
  });

  it('lets an operator point it at their own contact', () => {
    process.env.DISPATCH_VAPID_SUBJECT = 'mailto:ops@example.com';
    expect(vapidSubject()).toBe('mailto:ops@example.com');
  });

  it('falls back to the default when the override is blank', () => {
    process.env.DISPATCH_VAPID_SUBJECT = '   ';
    expect(vapidSubject()).toMatch(/^https:\/\//);
  });
});

describe('PushService revoke during a fan-out', () => {
  it('does not send to a device revoked while an earlier send was still waiting', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const got: string[] = [];
    const slow = new PushService(db, {
      vapidDir: dir,
      send: async (sub) => { got.push(sub.deviceId); if (sub.deviceId === 'phone') await gate; },
    });
    const run = slow.notifyThread({ terminalId: 't1', sessionId: 's1', title: 'x', body: 'y' });
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual(['phone']); // first send started and is waiting
    expect(slow.revoke('desk')).toBe(true);
    release();
    await run;
    expect(got).toEqual(['phone']); // desk was revoked before its send began
  });
});
