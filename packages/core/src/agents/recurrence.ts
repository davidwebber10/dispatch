import type { AgentScheduleRow } from '../db/agents.js';
import { minScheduleMinutes } from '../caps.js';

/**
 * Recurrence engine: turns a schedule's recurrence rule (or one-shot runAt) into
 * the next concrete UTC instant it should fire. Timezone-aware via Intl.
 *
 * Supported recurrence_rule shapes (JSON):
 *   { "type": "manual" }                                   never auto-fires (run-now only)
 *   { "type": "interval", "everyMinutes": N }              every N minutes
 *   { "type": "interval-hours", "hours": N }               legacy: every N hours
 *   { "type": "daily", "time": "HH:MM" }                   daily at local time
 *   { "type": "weekly", "days": [0..6], "time": "HH:MM" }  weekly on weekdays (0=Sun) at local time
 *   { "type": "cron", "expr": "m h dom mon dow" }          standard 5-field cron, local time
 * One-shot schedules (schedule_kind === 'one-shot') fire once at run_at.
 */
export function computeNextRunAt(schedule: AgentScheduleRow, nowIso: string, opts: { fired?: boolean } = {}): string | null {
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) return null;
  const tz = schedule.timezone || 'UTC';

  if (schedule.schedule_kind === 'one-shot') {
    if (!schedule.run_at) return null;
    const at = new Date(schedule.run_at);
    if (Number.isNaN(at.getTime())) return null;
    return at.getTime() > now.getTime() ? at.toISOString() : null;
  }

  if (!schedule.recurrence_rule) return null;
  let rule: any;
  try { rule = JSON.parse(schedule.recurrence_rule); } catch { return null; }
  if (!rule || typeof rule !== 'object') return null;

  switch (rule.type) {
    case 'manual':
      return null;

    case 'interval':
    case 'interval-minutes':
    case 'interval-hours': {
      const minutes = rule.type === 'interval-hours'
        ? Number(rule.hours) * 60
        : Number(rule.everyMinutes ?? rule.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0) return null;
      // A schedule already stored with a shorter gap still runs, no more often than the minimum.
      return new Date(now.getTime() + Math.max(minutes, minScheduleMinutes()) * 60_000).toISOString();
    }

    case 'daily': {
      const t = parseHHMM(rule.time);
      if (!t) return null;
      return nextLocalTime(now, tz, [0, 1, 2, 3, 4, 5, 6], t.h, t.mi);
    }

    case 'weekly': {
      const t = parseHHMM(rule.time);
      if (!t) return null;
      const days = Array.isArray(rule.days)
        ? rule.days.map(Number).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6)
        : [];
      if (!days.length) return null;
      return nextLocalTime(now, tz, days, t.h, t.mi);
    }

    case 'cron': {
      const expr = String(rule.expr ?? '');
      const next = nextCron(expr, now, tz);
      return next ? holdCronToMinimum(expr, next, now, tz, !!opts.fired) : null;
    }

    default:
      return null;
  }
}

function parseHHMM(s: any): { h: number; mi: number } | null {
  const [hr, mr] = String(s ?? '').split(':');
  const h = Number(hr), mi = Number(mr);
  if (!Number.isInteger(h) || !Number.isInteger(mi) || h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return { h, mi };
}

// --- timezone helpers (no external deps) ---

// Local wall-clock parts of a UTC instant in the given tz.
function zonedParts(instant: Date, tz: string): { y: number; mo: number; d: number; wd: number; h: number; mi: number } {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const m: Record<string, string> = {};
  for (const p of f.formatToParts(instant)) m[p.type] = p.value;
  const wd: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let h = Number(m.hour); if (h === 24) h = 0;
  return { y: Number(m.year), mo: Number(m.month) - 1, d: Number(m.day), wd: wd[m.weekday] ?? 0, h, mi: Number(m.minute) };
}

// tz offset (ms) at an instant: local = utc + offset.
function tzOffset(instant: Date, tz: string): number {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const m: Record<string, number> = {};
  for (const p of f.formatToParts(instant)) if (p.type !== 'literal') m[p.type] = Number(p.value);
  let h = m.hour; if (h === 24) h = 0;
  return Date.UTC(m.year, m.month - 1, m.day, h, m.minute, m.second) - instant.getTime();
}

// Convert a wall-clock time in tz to the corresponding UTC instant.
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, mo, d, h, mi, 0, 0);
  const off1 = tzOffset(new Date(guess), tz);
  let utc = guess - off1;
  const off2 = tzOffset(new Date(utc), tz);
  if (off2 !== off1) utc = guess - off2;
  return new Date(utc);
}

// Next instant that is one of `days` (0=Sun) at local h:mi, strictly after now.
function nextLocalTime(now: Date, tz: string, days: number[], h: number, mi: number): string | null {
  for (let i = 0; i < 8; i++) {
    const probe = new Date(now.getTime() + i * 86_400_000);
    const p = zonedParts(probe, tz);
    if (!days.includes(p.wd)) continue;
    const cand = zonedToUtc(p.y, p.mo, p.d, h, mi, tz);
    if (cand.getTime() > now.getTime()) return cand.toISOString();
  }
  return null;
}

// --- cron (5-field: minute hour day-of-month month day-of-week, 0=Sun) ---

function cronField(spec: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    let range = part, step = 1;
    const slash = part.split('/');
    if (slash.length === 2) { range = slash[0]; step = Number(slash[1]); if (!Number.isInteger(step) || step <= 0) return null; }
    let lo = min, hi = max;
    if (range !== '*') {
      const dash = range.split('-');
      if (dash.length === 1) { lo = hi = Number(dash[0]); }
      else if (dash.length === 2) { lo = Number(dash[0]); hi = Number(dash[1]); }
      else return null;
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
    }
    for (let v = lo; v <= hi; v += step) { if (v < min || v > max) return null; out.add(v); }
  }
  return out.size ? out : null;
}

function nextCron(expr: string, now: Date, tz: string): string | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const minute = cronField(f[0], 0, 59);
  const hour = cronField(f[1], 0, 23);
  const dom = cronField(f[2], 1, 31);
  const month = cronField(f[3], 1, 12);
  let dow = cronField(f[4], 0, 7);
  if (!minute || !hour || !dom || !month || !dow) return null;
  if (dow.has(7)) dow.add(0); // both 0 and 7 are Sunday
  const domRestricted = f[2] !== '*';
  const dowRestricted = f[4] !== '*';

  // Step forward in local wall-clock minutes (cheap integer math); convert a match to UTC once.
  const start = zonedParts(new Date(now.getTime() + 60_000), tz); // start at next minute
  let { y, mo, d, h, mi } = start;
  const MAX = 366 * 24 * 60;
  for (let i = 0; i < MAX; i++) {
    const wd = new Date(Date.UTC(y, mo, d)).getUTCDay();
    // cron day-of-month / day-of-week: if both restricted, match either; else match the restricted one(s).
    const domOk = dom.has(d);
    const dowOk = dow.has(wd);
    const dayOk = (domRestricted && dowRestricted) ? (domOk || dowOk) : (domOk && dowOk);
    if (minute.has(mi) && hour.has(h) && month.has(mo + 1) && dayOk) {
      const cand = zonedToUtc(y, mo, d, h, mi, tz);
      if (cand.getTime() > now.getTime()) return cand.toISOString();
    }
    // advance one local minute
    if (++mi > 59) { mi = 0; if (++h > 23) { h = 0; if (++d > daysInMonth(y, mo)) { d = 1; if (++mo > 11) { mo = 0; y++; } } } }
  }
  return null;
}

/**
 * A stored cron rule that runs more often than the minimum still runs, no more often than the minimum
 * (the same promise an interval rule gets above). When `fired` is set (the scheduler has just started a
 * run), the gap is counted from the start of the minute of that run: a late tick is counted from when it
 * ran, not from when it was due. A rule is held back when that gap or the gap after the next run is below
 * the minimum. A create or an edit passes no `fired`, so a normal rule is never delayed by an edit.
 * A daily or hourly cron is never pushed to a later run.
 */
function holdCronToMinimum(expr: string, next: string, now: Date, tz: string, fired: boolean): string | null {
  const min = minScheduleMinutes();
  if (!min) return next;
  const limit = min * 60_000;
  const nextMs = new Date(next).getTime();
  const minuteStart = Math.floor(now.getTime() / 60_000) * 60_000;
  const after = nextCron(expr, new Date(next), tz);
  const denseAfter = !!after && new Date(after).getTime() - nextMs < limit;
  const denseBefore = fired && nextMs - minuteStart < limit;
  if (!denseAfter && !denseBefore) return next;
  const earliest = minuteStart + limit;
  if (nextMs >= earliest) return next;
  return nextCron(expr, new Date(earliest - 1), tz);
}

function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
}


/**
 * A message when a recurring rule would run more often than the minimum (DISPATCH_MIN_SCHEDULE_MINUTES,
 * default 1 minute), else null. Checked when a schedule is created or changed. An interval is compared
 * as written; a cron rule by the gap between its next two runs.
 */
export function scheduleTooFrequent(recurrenceRule: string | null | undefined, nowIso: string = new Date().toISOString()): string | null {
  const min = minScheduleMinutes();
  if (!min || !recurrenceRule) return null;
  let rule: any;
  try { rule = JSON.parse(recurrenceRule); } catch { return null; }
  if (!rule || typeof rule !== 'object') return null;
  const message = (every: number) => `This schedule would run every ${every} minute(s). The shortest allowed gap is ${min} minute(s) (DISPATCH_MIN_SCHEDULE_MINUTES).`;
  if (rule.type === 'interval' || rule.type === 'interval-minutes' || rule.type === 'interval-hours') {
    const minutes = rule.type === 'interval-hours' ? Number(rule.hours) * 60 : Number(rule.everyMinutes ?? rule.minutes);
    if (Number.isFinite(minutes) && minutes > 0 && minutes < min) return message(minutes);
    return null;
  }
  if (rule.type === 'cron') {
    // Look at the next three runs (two gaps), so a rule with a short gap inside a cluster of runs is
    // refused whatever the time of the check (0,1 * * * * is refused at 11:59 and at 12:00 alike).
    let at = new Date(nowIso);
    let gap = Infinity;
    let last: number | null = null;
    for (let i = 0; i < 3; i++) {
      const run = nextCron(String(rule.expr ?? ''), at, 'UTC');
      if (!run) return null;
      const t = new Date(run).getTime();
      if (last !== null) gap = Math.min(gap, (t - last) / 60_000);
      last = t;
      at = new Date(run);
    }
    if (gap < min) return message(gap);
  }
  return null;
}

/** Two stored rules mean the same thing (same JSON, whatever the spacing or key order). */
export function sameRule(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as object).sort(([x], [y]) => x.localeCompare(y)).map(([k, x]) => [k, canon(x)])) : v;
  try { return JSON.stringify(canon(JSON.parse(a))) === JSON.stringify(canon(JSON.parse(b))); } catch { return false; }
}
