// packages/core/src/os/idle-info.ts
// What OS needs to put an idle box to sleep without stepping on work (capability `idle-info`).
//
//   automations     the work this daemon starts BY ITSELF on a timer, while nobody is connected:
//                   - agent schedules (agent_schedules: enabled = 1 and a next_run_at; the 30 s
//                     scheduler tick of daemon/timers.ts runs them)
//                   - plugin worker jobs (a running worker's `jobs[].cron`, plugins/workers.ts tick)
//                   - threads parked on a usage limit (usage_limit_parks state 'parked'; the
//                     usage-limits tick sends the resume at wake_at)
//                   `enabled`: how many; `nextRunAt`: the soonest next run (ISO), null when none. A
//                   schedule whose time passed while the box slept is due: its nextRunAt is in the past.
//   lastActivityAt  the newest of: a person's message to a thread (source 'user'), a thread turn
//                   (terminals.last_activity_at: a status change to working / idle / needs input /
//                   error, or a CLI output burst that crossed the busy threshold; never 'starting',
//                   never an attach or repaint), an automation run (agent_runs created, started or
//                   completed). The heartbeat, the OS connections poll and an open page with no
//                   action never move it.
//
// NOT counted (they fire on events, are short housekeeping, or would keep a box awake for ever):
// thread watches (event driven), the delivery outbox retries, the interim recap sweep, auto-archive,
// the stall watchdog, the plugin marketplace update check, telemetry, the usage gauge, the heartbeat.
import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';

/** app_state key: when a person last sent a message to a thread. */
export const PERSON_MESSAGE_KEY = 'activity.person_message_at';

export interface IdleInfo {
  automations: {
    enabled: number;
    nextRunAt: string | null;
    kinds: { schedules: number; pluginJobs: number; parkedThreads: number };
  };
  lastActivityAt: string | null;
}

/** The plugin jobs a running worker will fire, and the soonest one. */
export interface PluginJobsInfo { count: number; nextRunAt: string | null }

/** Stamp a person's message (never a daemon, peer or plugin message). */
export function notePersonMessage(db: Database.Database, at = new Date()): void {
  try { appState.set(db, PERSON_MESSAGE_KEY, at.toISOString()); } catch { /* a stamp never blocks a send */ }
}

const newest = (xs: Array<string | null | undefined>): string | null => {
  let best: { t: number; s: string } | null = null;
  for (const s of xs) {
    if (!s) continue;
    const t = Date.parse(s);
    if (Number.isNaN(t)) continue;
    if (!best || t > best.t) best = { t, s };
  }
  return best?.s ?? null;
};

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

export function collectIdleInfo(db: Database.Database, pluginJobs: PluginJobsInfo = { count: 0, nextRunAt: null }): IdleInfo {
  const sched = safe(() => db.prepare(`SELECT COUNT(*) AS n, MIN(next_run_at) AS next FROM agent_schedules WHERE enabled = 1 AND next_run_at IS NOT NULL`).get() as { n: number; next: string | null }, { n: 0, next: null });
  const parks = safe(() => db.prepare(`SELECT COUNT(*) AS n, MIN(wake_at) AS next FROM usage_limit_parks WHERE state = 'parked'`).get() as { n: number; next: number | null }, { n: 0, next: null });
  const parkNext = parks.next != null ? new Date(parks.next).toISOString() : null;
  const soonest = [sched.next, pluginJobs.nextRunAt, parkNext]
    .filter((s): s is string => !!s && !Number.isNaN(Date.parse(s)))
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;

  const thread = safe(() => (db.prepare(`SELECT MAX(last_activity_at) AS t FROM terminals`).get() as { t: string | null }).t, null);
  const run = safe(() => (db.prepare(`SELECT MAX(MAX(created_at, COALESCE(started_at, ''), COALESCE(completed_at, ''))) AS t FROM agent_runs`).get() as { t: string | null }).t, null);
  const person = safe(() => appState.get(db, PERSON_MESSAGE_KEY), null);

  return {
    automations: {
      enabled: sched.n + pluginJobs.count + parks.n,
      nextRunAt: soonest ? new Date(soonest).toISOString() : null,
      kinds: { schedules: sched.n, pluginJobs: pluginJobs.count, parkedThreads: parks.n },
    },
    lastActivityAt: newest([thread, run, person]),
  };
}
