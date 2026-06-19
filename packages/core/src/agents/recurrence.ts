import type { AgentScheduleRow } from '../db/agents.js';

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
export function computeNextRunAt(schedule: AgentScheduleRow, nowIso: string): string | null {
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
      return new Date(now.getTime() + minutes * 60_000).toISOString();
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

    case 'cron':
      return nextCron(String(rule.expr ?? ''), now, tz);

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

function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
}
