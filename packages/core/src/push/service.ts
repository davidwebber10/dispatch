import fs from 'fs';
import os from 'os';
import path from 'path';
import webpush from 'web-push';
import type Database from 'better-sqlite3';
import * as pushDb from '../db/push.js';
import { isAllowedPushEndpoint } from './endpoints.js';
import { maxPushSubscriptions } from '../caps.js';

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

/** The stored-subscription cap was reached by a new device. The message is safe to show the caller. */
export class PushLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Dispatch already stores ${limit} push subscriptions (the maximum). Remove an old device in Settings > Access, or raise DISPATCH_MAX_PUSH_SUBSCRIPTIONS.`);
  }
}

/** One stored subscription for the owner's list. The push address and keys never leave the daemon; only its host does. */
export interface PushSubscriptionView { deviceId: string; label: string; host: string; createdAt: string; lastSentAt: string | null }

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

  /** Store or refresh a device's subscription. A NEW device past the cap throws PushLimitError; a known device always updates. */
  subscribe(deviceId: string, subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, label?: string | null): void {
    const limit = maxPushSubscriptions();
    // A new device id that arrives with an address already stored replaces that row, so it adds nothing to the count.
    if (limit > 0 && !pushDb.has(this.db, deviceId) && !pushDb.hasEndpoint(this.db, subscription.endpoint) && pushDb.count(this.db) >= limit) throw new PushLimitError(limit);
    pushDb.upsert(this.db, { deviceId, endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth, label });
  }
  unsubscribe(deviceId: string): void { pushDb.remove(this.db, deviceId); this.presence.delete(deviceId); }

  /** The subscriptions for Settings: label, push-service host, created, last sent. */
  listSubscriptions(): PushSubscriptionView[] {
    return pushDb.listInfo(this.db).map((r) => {
      let host = 'unknown';
      try { host = new URL(r.endpoint).hostname; } catch { /* keep unknown */ }
      return { deviceId: r.deviceId, label: r.label || 'Unknown device', host, createdAt: r.createdAt, lastSentAt: r.lastSentAt };
    });
  }

  /** Owner revoke. Returns false when there is no such subscription. */
  revoke(deviceId: string): boolean {
    this.presence.delete(deviceId);
    return pushDb.remove(this.db, deviceId);
  }

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
    await this.fanOut(payload, (deviceId) => this.isViewing(deviceId, input.terminalId));
  }

  /**
   * A push about the account, not one thread (the usage warning, #127). Every device gets it,
   * foreground or not. `tag` coalesces repeats on the device; a tap opens `/`.
   */
  async notifyAccount(input: { title: string; body: string; tag: string }): Promise<void> {
    await this.fanOut(JSON.stringify({ title: input.title, body: input.body, tag: input.tag }), () => false);
  }

  private async fanOut(payload: string, skip: (deviceId: string) => boolean): Promise<void> {
    for (const sub of pushDb.list(this.db)) {
      // A subscription stored before the host check may point anywhere. Keep it, but never send to it.
      if (!isAllowedPushEndpoint(sub.endpoint)) continue;
      if (skip(sub.deviceId)) continue;
      // The list was read before the earlier sends were awaited; a device the owner revoked meanwhile gets nothing.
      if (!pushDb.has(this.db, sub.deviceId)) continue;
      try { await this.send(sub, payload); pushDb.markSent(this.db, sub.deviceId); }
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
