import type Database from 'better-sqlite3';

export interface PushSub { deviceId: string; endpoint: string; p256dh: string; auth: string }
interface Row { device_id: string; endpoint: string; p256dh: string; auth: string }

export function upsert(db: Database.Database, s: PushSub): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, created_at, updated_at)
    VALUES (@deviceId, @endpoint, @p256dh, @auth, @now, @now)
    ON CONFLICT(device_id) DO UPDATE SET endpoint=@endpoint, p256dh=@p256dh, auth=@auth, updated_at=@now`)
    .run({ ...s, now });
}
export function list(db: Database.Database): PushSub[] {
  return (db.prepare('SELECT device_id, endpoint, p256dh, auth FROM push_subscriptions').all() as Row[])
    .map((r) => ({ deviceId: r.device_id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }));
}
export function remove(db: Database.Database, deviceId: string): void {
  db.prepare('DELETE FROM push_subscriptions WHERE device_id = ?').run(deviceId);
}
export function removeByEndpoint(db: Database.Database, endpoint: string): void {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}
