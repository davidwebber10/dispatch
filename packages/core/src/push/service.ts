import fs from 'fs';
import os from 'os';
import path from 'path';
import webpush from 'web-push';
import type Database from 'better-sqlite3';
import * as pushDb from '../db/push.js';

export type Sender = (sub: pushDb.PushSub, payload: string) => Promise<void>;
const PRESENCE_TTL_MS = 90_000;

/**
 * The VAPID `sub` claim identifying this push sender. Apple validates it and
 * rejects a non-routable subject with 403 BadJwtToken — the previous
 * 'mailto:dispatch@localhost' silently broke EVERY notification to an iPhone
 * (403 is not 404/410, so the dead sends didn't even prune). Chrome/FCM accepts
 * anything, which is how it shipped unnoticed. Operators running their own
 * instance can point it at their own contact.
 */
export function vapidSubject(): string {
  return process.env.DISPATCH_VAPID_SUBJECT?.trim() || 'https://github.com/davidwebber10/dispatch';
}

export class PushService {
  private db: Database.Database;
  private vapid: { publicKey: string; privateKey: string };
  private send: Sender;
  private presence = new Map<string, { foreground: boolean; activeTerminalId: string | null; ts: number }>();

  constructor(db: Database.Database, opts: { vapidDir?: string; send?: Sender } = {}) {
    this.db = db;
    const dir = opts.vapidDir ?? path.join(os.homedir(), '.dispatch');
    this.vapid = this.loadOrCreateVapid(dir);
    webpush.setVapidDetails(vapidSubject(), this.vapid.publicKey, this.vapid.privateKey);
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

  setPresence(deviceId: string, foreground: boolean, activeTerminalId: string | null = null): void {
    this.presence.set(deviceId, { foreground, activeTerminalId, ts: Date.now() });
  }

  /** "Notify unless viewing it": suppress only a fresh, foregrounded report of THIS thread. */
  private isViewing(deviceId: string, terminalId: string): boolean {
    const p = this.presence.get(deviceId);
    if (!p) return false;
    if (Date.now() - p.ts > PRESENCE_TTL_MS) return false;
    return p.foreground && p.activeTerminalId === terminalId;
  }

  async notifyThread(input: { terminalId: string; sessionId: string; title: string; body: string }): Promise<void> {
    const payload = JSON.stringify({ title: input.title, body: input.body, terminalId: input.terminalId, sessionId: input.sessionId });
    for (const sub of pushDb.list(this.db)) {
      if (this.isViewing(sub.deviceId, input.terminalId)) continue;
      try { await this.send(sub, payload); }
      catch (e: any) {
        const code = e?.statusCode;
        if (code === 404 || code === 410) pushDb.removeByEndpoint(this.db, sub.endpoint);
        // Keep the provider's reason (e.g. Apple's {"reason":"BadJwtToken"}) — a bare
        // status code left a silent, undiagnosable failure for the whole 2.3.x line.
        else console.error('PushService: send failed', code ?? e?.message, String(e?.body ?? '').slice(0, 200));
      }
    }
  }
}
