import { describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import { collectHeartbeat, HeartbeatService } from './heartbeat.js';

function db() {
  const d = new Database(':memory:');
  initSchema(d);
  d.prepare(`INSERT INTO sessions (id, provider, name, status, working_dir, created_at, updated_at, last_activity_at)
             VALUES ('s1','claude-code','p','waiting','/w','t','t','t')`).run();
  return d;
}
function addThread(d: any, id: string, status: string, activity: string | null, archived: string | null = null) {
  d.prepare(`INSERT INTO terminals (id, session_id, type, label, status, created_at, last_activity_at, archived_at)
             VALUES (?,?,?,?,?,?,?,?)`).run(id, 's1', 'claude-code', id, status, 't', activity, archived);
}

describe('collectHeartbeat', () => {
  test('counts threads by status and reports the newest activity', () => {
    const d = db();
    addThread(d, 't1', 'working', '2026-07-25T10:00:00Z');
    addThread(d, 't2', 'needs_input', '2026-07-25T12:00:00Z');
    addThread(d, 't3', 'waiting', '2026-07-25T09:00:00Z');
    addThread(d, 't4', 'error', null);
    const h = collectHeartbeat(d, { authenticated: true, toolsReachable: true, ownerEmail: 'a@b.c' });
    expect(h.threads).toEqual({ total: 4, working: 1, needsInput: 1, error: 1 });
    expect(h.lastActivityAt).toBe('2026-07-25T12:00:00Z');
    expect(h.ownerEmail).toBe('a@b.c');
    expect(h.authenticated).toBe(true);
  });

  test('excludes archived threads — the bell should not badge retired work', () => {
    const d = db();
    addThread(d, 't1', 'needs_input', '2026-07-25T10:00:00Z');
    addThread(d, 't2', 'needs_input', '2026-07-25T11:00:00Z', '2026-07-25T11:30:00Z');
    expect(collectHeartbeat(d, { authenticated: true, toolsReachable: true }).threads.needsInput).toBe(1);
  });

  test('a broken query yields an empty reading rather than throwing', () => {
    // A projection must never be able to take the daemon down.
    const broken: any = { prepare() { throw new Error('db closed'); } };
    const h = collectHeartbeat(broken, { authenticated: false, toolsReachable: false });
    expect(h.threads.total).toBe(0);
  });
});

describe('HeartbeatService', () => {
  const opts = { baseUrl: 'https://os.example', boxToken: 'tok', ownerEmail: 'a@b.c', boxId: 'box1' };

  test('disabled without OS config', () => {
    const svc = new HeartbeatService(db(), () => ({ authenticated: true, toolsReachable: true }),
      { baseUrl: undefined, boxToken: undefined, fetchImpl: vi.fn() as any });
    expect(svc.enabled).toBe(false);
  });

  test('POSTs the projection with the box token', async () => {
    const d = db();
    addThread(d, 't1', 'needs_input', '2026-07-25T10:00:00Z');
    const f = vi.fn().mockResolvedValue({ ok: true });
    const svc = new HeartbeatService(d, () => ({ authenticated: true, toolsReachable: false }),
      { ...opts, fetchImpl: f as any });
    expect(await svc.send()).toBe(true);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://os.example/api/dispatch/heartbeat');
    expect(init.headers['x-dispatch-box-token']).toBe('tok');
    const body = JSON.parse(init.body);
    expect(body.threads.needsInput).toBe(1);
    expect(body.toolsReachable).toBe(false);
    expect(body.boxId).toBe('box1');
  });

  test('a failed beat resolves false instead of throwing', async () => {
    const svc = new HeartbeatService(db(), () => ({ authenticated: true, toolsReachable: true }),
      { ...opts, fetchImpl: vi.fn().mockRejectedValue(new Error('down')) as any });
    expect(await svc.send()).toBe(false);
  });
});
