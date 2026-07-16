import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/connection.js';
import * as pushDb from '../db/push.js';
import { PushService } from './service.js';

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
  pushDb.upsert(db, { deviceId: 'phone', endpoint: 'https://push/phone', p256dh: 'k', auth: 'a' });
  pushDb.upsert(db, { deviceId: 'desk', endpoint: 'https://push/desk', p256dh: 'k', auth: 'a' });
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

  it('prunes a subscription when the endpoint returns 410', async () => {
    svc = new PushService(db, {
      vapidDir: dir,
      send: async (sub) => { if (sub.deviceId === 'phone') { const e: any = new Error('gone'); e.statusCode = 410; throw e; } },
    });
    await notify();
    expect(pushDb.list(db).map((s) => s.deviceId)).toEqual(['desk']);
  });
});
