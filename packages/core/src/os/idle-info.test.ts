import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import { collectIdleInfo, notePersonMessage } from './idle-info.js';
import { collectHeartbeat } from '../platform/heartbeat.js';

function db() {
  const d = new Database(':memory:');
  initSchema(d);
  d.prepare(`INSERT INTO sessions (id, provider, name, status, working_dir, created_at, updated_at, last_activity_at) VALUES ('s1','claude-code','p','waiting','/w','t','t','t')`).run();
  return d;
}
function schedule(d: any, id: string, enabled: number, next: string | null) {
  d.prepare(`INSERT INTO agent_schedules (id, project_id, name, provider, working_dir, prompt, schedule_kind, timezone, enabled, next_run_at, created_at, updated_at)
             VALUES (?, 's1', ?, 'claude-code', '/w', 'p', 'recurring', 'UTC', ?, ?, 't', 't')`).run(id, id, enabled, next);
}

describe('idle info (heartbeat `automations`, `lastActivityAt`)', () => {
  test('no automations: 0 and null', () => {
    const h = collectHeartbeat(db(), { authenticated: true, toolsReachable: true });
    expect(h.automations).toEqual({ enabled: 0, nextRunAt: null, kinds: { schedules: 0, pluginJobs: 0, parkedThreads: 0 } });
    expect(h.capabilities).toContain('idle-info');
  });

  test('enabled schedules count, disabled ones and ones with no next run do not; nextRunAt is the soonest of every kind', () => {
    const d = db();
    schedule(d, 'a', 1, '2026-12-01T09:00:00.000Z');
    schedule(d, 'b', 1, '2026-11-20T09:00:00.000Z');
    schedule(d, 'off', 0, '2026-11-12T09:00:00.000Z');
    schedule(d, 'manual', 1, null);
    expect(collectIdleInfo(d).automations).toEqual({ enabled: 2, nextRunAt: '2026-11-20T09:00:00.000Z', kinds: { schedules: 2, pluginJobs: 0, parkedThreads: 0 } });
    // A plugin job and a parked thread count too, and the soonest wins.
    d.prepare(`INSERT INTO usage_limit_parks (terminal_id, provider, kind, resets_at, wake_at, message, parked_at, updated_at) VALUES ('t9','claude','weekly',NULL,?,'m',0,0)`).run(Date.parse('2026-11-15T00:00:00Z'));
    const info = collectIdleInfo(d, { count: 1, nextRunAt: '2026-11-18T00:00:00.000Z' });
    expect(info.automations).toEqual({ enabled: 4, nextRunAt: '2026-11-15T00:00:00.000Z', kinds: { schedules: 2, pluginJobs: 1, parkedThreads: 1 } });
  });

  test('lastActivityAt: the newest of a thread turn, a person message and an automation run', () => {
    const d = db();
    expect(collectIdleInfo(d).lastActivityAt).toBeNull();
    d.prepare(`INSERT INTO terminals (id, session_id, type, label, status, created_at, last_activity_at) VALUES ('t1','s1','claude-code','x','waiting','t','2026-11-01T10:00:00.000Z')`).run();
    expect(collectIdleInfo(d).lastActivityAt).toBe('2026-11-01T10:00:00.000Z');
    notePersonMessage(d, new Date('2026-11-02T10:00:00.000Z'));
    expect(collectIdleInfo(d).lastActivityAt).toBe('2026-11-02T10:00:00.000Z');
    schedule(d, 'a', 1, null);
    d.prepare(`INSERT INTO agent_runs (id, schedule_id, project_id, provider, prompt_snapshot, status, started_at, completed_at, created_at, updated_at)
               VALUES ('r1','a','s1','claude-code','p','completed','2026-11-03T10:00:00.000Z','2026-11-03T10:05:00.000Z','2026-11-03T10:00:00.000Z','2026-11-03T10:05:00.000Z')`).run();
    expect(collectIdleInfo(d).lastActivityAt).toBe('2026-11-03T10:05:00.000Z');
  });

  test('collecting a heartbeat (or many) never moves lastActivityAt', () => {
    const d = db();
    notePersonMessage(d, new Date('2026-11-02T10:00:00.000Z'));
    for (let i = 0; i < 3; i++) expect(collectHeartbeat(d, { authenticated: true, toolsReachable: true }).lastActivityAt).toBe('2026-11-02T10:00:00.000Z');
  });
});
