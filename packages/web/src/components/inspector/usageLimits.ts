import type { LimitWindow, ThreadUsageLimits } from '../../api/types';

const DAY = 24 * 3600_000;
const clock = (ms: number, zone?: string) => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone }).format(new Date(ms));
const weekday = (ms: number, zone?: string) => new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: zone }).format(new Date(ms));

/** "1:10 AM" when it is within a day, "Thu 3:41 PM" later (or earlier than a day ago). */
export function whenLabel(ms: number, now: number, zone?: string): string {
  return Math.abs(ms - now) < DAY - 60_000 ? clock(ms, zone) : `${weekday(ms, zone)} ${clock(ms, zone)}`;
}

/** "62% used, resets 1:10 AM". A window already past its reset says so rather than showing the old figure. */
export function windowLabel(w: LimitWindow, now: number, zone?: string): string {
  if (w.resetsAt !== null && w.resetsAt <= now) return `Reset ${whenLabel(w.resetsAt, now, zone)}, no new figure yet`;
  const reset = w.resetsAt === null ? '' : `, resets ${whenLabel(w.resetsAt, now, zone)}`;
  return w.usedPercent === null ? `Under the warning level${reset}` : `${Math.round(w.usedPercent)}% used${reset}`;
}

const KIND = { session: 'session limit', weekly: 'weekly limit', usage: 'usage limit' } as const;

/** "Paused: session limit, resumes 1:10 AM", the same words the pause itself shows. */
export function pausedLabel(p: NonNullable<ThreadUsageLimits['paused']>, now: number, zone?: string): string {
  if (p.capped) return `Stopped: ${KIND[p.kind]}, auto-resume gave up`;
  return `Paused: ${KIND[p.kind]}, ${p.resetsAt === null ? 'reset time unknown' : `resumes ${whenLabel(p.resetsAt, now, zone)}`}`;
}

/** Row labels by limit type, matching Claude Code's own names (CLI 2.1.309). Codex uses the first two. */
export const TYPE_LABEL: Record<string, string> = {
  five_hour: 'Session (5h)',
  seven_day: 'Weekly',
  seven_day_opus: 'Opus',
  seven_day_sonnet: 'Sonnet',
  seven_day_overage_included: 'Fable',
  overage: 'Usage credit',
};

export interface LimitRows { rows: { label: string; value: string }[]; asOf: string | null; paused: string | null }

export function limitRows(d: ThreadUsageLimits, now: number, zone?: string): LimitRows {
  const paused = d.paused ? pausedLabel(d.paused, now, zone) : null;
  if (!d.supported) return { rows: [{ label: 'Usage limits', value: 'Not reported' }], asOf: null, paused };
  const s = d.snapshot;
  if (!s) return { rows: [{ label: 'Usage limits', value: 'Not reported yet' }], asOf: null, paused };
  const rows: { label: string; value: string }[] = [];
  // Known types in the CLI's own order, then any other type under its raw name (never a guess).
  const known = Object.keys(TYPE_LABEL).filter((t) => s.windows[t]);
  const unknown = Object.keys(s.windows).filter((t) => !(t in TYPE_LABEL)).sort();
  for (const t of [...known, ...unknown]) rows.push({ label: TYPE_LABEL[t] ?? t, value: windowLabel(s.windows[t], now, zone) });
  if (rows.length === 0) rows.push({ label: 'Usage limits', value: 'Not reported yet' });
  return { rows, asOf: `As of ${whenLabel(s.asOf, now, zone)}`, paused };
}
