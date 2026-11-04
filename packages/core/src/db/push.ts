import type Database from 'better-sqlite3';

export interface PushSub { deviceId: string; endpoint: string; p256dh: string; auth: string; label?: string | null }
/** A stored subscription as the owner's list shows it: no keys, no push address. */
export interface PushSubInfo { deviceId: string; endpoint: string; label: string | null; createdAt: string; lastSentAt: string | null }
interface Row { device_id: string; endpoint: string; p256dh: string; auth: string }
interface InfoRow { device_id: string; endpoint: string; label: string | null; created_at: string; last_sent_at: string | null }

/**
 * Store or refresh a device's subscription. Any OTHER row with the same push address is removed in the same step:
 * a browser that cleared its storage comes back with a new device id but the same address, and two rows would send
 * it every alert twice and count twice toward the cap.
 */
export function upsert(db: Database.Database, s: PushSub): void {
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND device_id != ?').run(s.endpoint, s.deviceId);
    db.prepare(`INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, label, created_at, updated_at)
      VALUES (@deviceId, @endpoint, @p256dh, @auth, @label, @now, @now)
      ON CONFLICT(device_id) DO UPDATE SET endpoint=@endpoint, p256dh=@p256dh, auth=@auth,
        label=COALESCE(@label, label), updated_at=@now`)
      .run({ deviceId: s.deviceId, endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth, label: s.label ?? null, now });
  })();
}
export function list(db: Database.Database): PushSub[] {
  return (db.prepare('SELECT device_id, endpoint, p256dh, auth FROM push_subscriptions').all() as Row[])
    .map((r) => ({ deviceId: r.device_id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }));
}
/** The list for Settings: oldest first. */
export function listInfo(db: Database.Database): PushSubInfo[] {
  return (db.prepare('SELECT device_id, endpoint, label, created_at, last_sent_at FROM push_subscriptions ORDER BY created_at ASC, rowid ASC').all() as InfoRow[])
    .map((r) => ({ deviceId: r.device_id, endpoint: r.endpoint, label: r.label, createdAt: r.created_at, lastSentAt: r.last_sent_at }));
}
export function count(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as { n: number }).n;
}
export function has(db: Database.Database, deviceId: string): boolean {
  return db.prepare('SELECT 1 FROM push_subscriptions WHERE device_id = ?').get(deviceId) !== undefined;
}
export function hasEndpoint(db: Database.Database, endpoint: string): boolean {
  return db.prepare('SELECT 1 FROM push_subscriptions WHERE endpoint = ?').get(endpoint) !== undefined;
}
export function markSent(db: Database.Database, deviceId: string): void {
  db.prepare('UPDATE push_subscriptions SET last_sent_at = ? WHERE device_id = ?').run(new Date().toISOString(), deviceId);
}
/** Returns true when a row was removed. */
export function remove(db: Database.Database, deviceId: string): boolean {
  return db.prepare('DELETE FROM push_subscriptions WHERE device_id = ?').run(deviceId).changes > 0;
}
export function removeByEndpoint(db: Database.Database, endpoint: string): void {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}
