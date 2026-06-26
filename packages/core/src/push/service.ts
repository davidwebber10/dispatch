import fs from 'fs';
import os from 'os';
import path from 'path';
import webpush from 'web-push';
import type Database from 'better-sqlite3';
import * as pushDb from '../db/push.js';

export type Sender = (sub: pushDb.PushSub, payload: string) => Promise<void>;
const PRESENCE_TTL_MS = 90_000;

export class PushService {
  private db: Database.Database;
  private vapid: { publicKey: string; privateKey: string };
  private send: Sender;
  private presence = new Map<string, { foreground: boolean; ts: number }>();

  constructor(db: Database.Database, opts: { vapidDir?: string; send?: Sender } = {}) {
    this.db = db;
    const dir = opts.vapidDir ?? path.join(os.homedir(), '.dispatch');
    this.vapid = this.loadOrCreateVapid(dir);
    webpush.setVapidDetails('mailto:dispatch@localhost', this.vapid.publicKey, this.vapid.privateKey);
    this.send = opts.send ?? (async (sub, payload) => {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
    });
  }

  private loadOrCreateVapid(dir: string): { publicKey: string; privateKey: string } {
    const file = path.join(dir, 'push.json');
    try { const j = JSON.parse(fs.readFileSync(file, 'utf-8')); if (j.publicKey && j.privateKey) return j; } catch { /* create below */ }
    const keys = webpush.generateVAPIDKeys();
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 }); try { fs.chmodSync(file, 0o600); } catch { /* best effort */ } } catch { /* ephemeral if unwritable */ }
    return keys;
  }

  getPublicKey(): string { return this.vapid.publicKey; }

  subscribe(deviceId: string, subscription: { endpoint: string; keys: { p256dh: string; auth: string } }): void {
    pushDb.upsert(this.db, { deviceId, endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth });
  }
  unsubscribe(deviceId: string): void { pushDb.remove(this.db, deviceId); }

  setPresence(deviceId: string, foreground: boolean): void { this.presence.set(deviceId, { foreground, ts: Date.now() }); }

  private isAway(deviceId: string): boolean {
    const p = this.presence.get(deviceId);
    if (!p) return true;                       // never reported → assume away (notify)
    if (Date.now() - p.ts > PRESENCE_TTL_MS) return true; // stale
    return !p.foreground;
  }

  async notifyThread(input: { terminalId: string; title: string; body: string }): Promise<void> {
    const payload = JSON.stringify({ title: input.title, body: input.body, terminalId: input.terminalId });
    for (const sub of pushDb.list(this.db)) {
      if (!this.isAway(sub.deviceId)) continue;
      try { await this.send(sub, payload); }
      catch (e: any) {
        const code = e?.statusCode;
        if (code === 404 || code === 410) pushDb.removeByEndpoint(this.db, sub.endpoint);
        else console.error('PushService: send failed', code ?? e?.message);
      }
    }
  }
}
