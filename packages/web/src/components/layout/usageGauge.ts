// The usage gauge's pure logic (#127): which provider the chip shows, its color, labels and
// staleness, the popover table, and the paused banner's copy. (Not `usageChip.ts`: beside
// `UsageChip.tsx` that name collides on a case-insensitive disk.)
import type { LimitWindow, UsageSummary, UsageSummaryProvider, UsagePausedGroup } from '../../api/types';
import { TYPE_LABEL, HIDDEN_TYPES, whenLabel, windowLabel } from '../inspector/usageLimits';

/** Windows that count toward the warning. Not `overage` (usage credit). Codex has the first two. */
export const COUNTED = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_fable'] as const;
const WEEKLY = COUNTED.filter((t) => t !== 'five_hour');
/** Figures older than this render dimmed: CLI threads never report, so the last figure can be old. */
export const STALE_MS = 30 * 60_000;
export const PROVIDER_NAME: Record<string, string> = { 'claude-code': 'Claude', codex: 'Codex', grok: 'Grok' };
const MARK: Record<string, string> = { 'claude-code': 'C', codex: 'X' };
export const CLI_NOTE = 'Only Pretty threads and Chat report usage. CLI threads do not.';

export type ChipTone = 'normal' | 'amber' | 'red';

/** A window's figure only while it is current: past its reset, or with no figure, it is null (shown `–`). */
export function liveValue(w: LimitWindow | undefined, now: number): number | null {
  if (!w || w.usedPercent === null) return null;
  if (w.resetsAt !== null && w.resetsAt <= now) return null;
  return Math.round(w.usedPercent);
}

/** The highest counted live window of a provider: its type and percent, or null. */
export function peakWindow(p: UsageSummaryProvider, now: number, types: readonly string[] = COUNTED): { type: string; value: number } | null {
  let best: { type: string; value: number } | null = null;
  for (const t of types) {
    const v = liveValue(p.windows[t], now);
    if (v !== null && (!best || v > best.value)) best = { type: t, value: v };
  }
  return best;
}

/**
 * Providers whose pause is still holding them back. A group stays in the banner until its thread
 * resumes or is messaged, but the chip is red only while the limit is on: past `activeUntil` the
 * window has reset, so the chip shows normal or amber again. A null or missing end time (a reset that
 * was never read, or an older daemon) is active: the daemon sends a time once the limit clears.
 */
export function activePaused(s: UsageSummary, now: number): Set<string> {
  return new Set(s.paused.filter((g) => g.activeUntil == null || g.activeUntil > now).map((g) => g.provider));
}

export interface ChipModel {
  provider: string;
  /** `C` or `X`, only when more than one provider has figures or is paused. */
  mark: string | null;
  tone: ChipTone;
  stale: boolean;
  /** Rail lines: the 5-hour figure and the highest weekly one, `–` when none is current. */
  five: string;
  week: string;
  /** Phone: the higher of the two, `46%`, or `–`. */
  peak: string;
  /** Tooltip and accessible name. */
  title: string;
}

const dash = (v: number | null) => (v === null ? '–' : String(v));

/**
 * The chip, or null when no provider has reported anything yet and none is paused (a
 * placeholder on a fresh install is noise). Shows one provider: a paused one first (red), else
 * the one with the highest counted window. Amber when any counted window is at or above the threshold.
 */
export function chipModel(s: UsageSummary | null, now: number): ChipModel | null {
  if (!s) return null;
  const paused = activePaused(s, now);
  // A paused provider with no figures yet is still a candidate, with every percent unknown, so a
  // paused Codex never hides behind a normal Claude chip. `asOf: now` keeps it from reading stale.
  const candidates: UsageSummaryProvider[] = [...s.providers];
  for (const p of paused) if (!candidates.some((c) => c.provider === p)) candidates.push({ provider: p, asOf: now, windows: {} });
  if (candidates.length === 0) return null;
  const score = (p: UsageSummaryProvider) => (paused.has(p.provider) ? 1000 : 0) + (peakWindow(p, now)?.value ?? -1);
  const pick = candidates.reduce((a, b) => (score(b) > score(a) ? b : a));
  const peak = peakWindow(pick, now);
  const five = liveValue(pick.windows.five_hour, now);
  const week = peakWindow(pick, now, WEEKLY);
  const red = paused.has(pick.provider);
  const amber = !red && !!peak && peak.value >= s.warnPercent;
  const name = PROVIDER_NAME[pick.provider] ?? pick.provider;
  const parts = [`${name} usage`, `Session (5h) ${five === null ? '–' : `${five}%`}`, `${week ? (TYPE_LABEL[week.type] ?? week.type) : 'Weekly'} ${week ? `${week.value}%` : '–'}`];
  let title = parts.join(', ');
  if (red) title += '. Agents paused on a limit';
  else if (amber && peak) title += `. ${TYPE_LABEL[peak.type] ?? peak.type} is past the ${s.warnPercent}% warning level`;
  const stale = now - pick.asOf > STALE_MS;
  if (stale) title += `. As of ${whenLabel(pick.asOf, now)}`;
  return {
    provider: pick.provider,
    mark: candidates.length > 1 ? MARK[pick.provider] ?? pick.provider.slice(0, 1).toUpperCase() : null,
    tone: red ? 'red' : amber ? 'amber' : 'normal',
    stale,
    five: dash(five),
    week: dash(week?.value ?? null),
    peak: peak ? `${peak.value}%` : '–',
    title,
  };
}

export const TONE_COLOR: Record<ChipTone, string> = {
  normal: 'var(--color-text-secondary)',
  amber: 'var(--color-status-yellow)',
  red: 'var(--color-status-red)',
};

export interface ProviderTable {
  provider: string;
  name: string;
  plan?: string;
  rows: { label: string; value: string; tone: ChipTone }[];
  asOf: string;
  stale: boolean;
}

/** The popover and the Settings table: every provider, its plan, windows, resets and "As of". */
export function usageTables(s: UsageSummary | null, now: number, zone?: string): ProviderTable[] {
  if (!s) return [];
  const paused = activePaused(s, now);
  return s.providers.map((p) => {
    const known = Object.keys(TYPE_LABEL).filter((t) => p.windows[t] && !HIDDEN_TYPES.has(t));
    const unknown = Object.keys(p.windows).filter((t) => !(t in TYPE_LABEL)).sort();
    const rows = [...known, ...unknown].map((t) => {
      const v = liveValue(p.windows[t], now);
      const counted = (COUNTED as readonly string[]).includes(t);
      const tone: ChipTone = counted && v !== null && v >= s.warnPercent ? (paused.has(p.provider) ? 'red' : 'amber') : 'normal';
      return { label: TYPE_LABEL[t] ?? t, value: windowLabel(p.windows[t], now, zone), tone };
    });
    return { provider: p.provider, name: PROVIDER_NAME[p.provider] ?? p.provider, plan: p.plan, rows, asOf: `As of ${whenLabel(p.asOf, now, zone)}`, stale: now - p.asOf > STALE_MS };
  });
}

const KIND: Record<string, string> = {
  session: 'session limit', weekly: 'weekly limit', fable: 'Fable limit', opus: 'Opus limit', sonnet: 'Sonnet limit', usage: 'usage limit',
};
/** Chat's own turn parks under this id (core limits/service.ts CHAT_ID). */
export const CHAT_PARK_ID = 'endless-chat';

const threadsLabel = (n: number) => `${n} thread${n === 1 ? '' : 's'}`;

/**
 * "Claude agents paused: session limit, resumes 1:10 AM (3 threads), 1 stopped after 5 tries".
 * Chat alone: "Chat paused: ...". Capped rows only: "... stopped: ..., auto-resume gave up (2 threads)".
 */
export function bannerText(g: UsagePausedGroup, now: number, zone?: string): string {
  const kind = KIND[g.kind] ?? 'usage limit';
  const chatOnly = g.chat && g.threads === 1;
  const who = chatOnly ? 'Chat' : `${PROVIDER_NAME[g.provider] ?? g.provider} agents`;
  const count = chatOnly ? '' : ` (${threadsLabel(g.threads)})`;
  if (g.capped >= g.threads) return `${who} stopped: ${kind}, auto-resume gave up${count}`;
  const when = g.earliestResetsAt === null ? 'reset time unknown' : g.earliestResetsAt <= now ? 'resuming now' : `resumes ${whenLabel(g.earliestResetsAt, now, zone)}`;
  const capped = g.capped > 0 ? `, ${g.capped} stopped after 5 tries` : '';
  return `${who} paused: ${kind}, ${when}${count}${capped}`;
}

// --- the ring sheet (2026-11-05) -----------------------------------------------------------

/** Ring colors: green, then yellow from 30 points below the warning, red from the warning. */
export type RingTone = 'green' | 'yellow' | 'red';
export const RING_COLOR: Record<RingTone, string> = { green: 'var(--color-accent)', yellow: 'var(--color-status-yellow)', red: 'var(--color-status-red)' };
export const yellowFrom = (warn: number) => Math.max(10, warn - 30);
export const ringTone = (used: number, warn: number): RingTone => (used >= warn ? 'red' : used >= yellowFrom(warn) ? 'yellow' : 'green');

export interface RingRow { type: string; label: string; left: number | null; tone: RingTone; reset: string | null; estimate: string | null; estimateTitle: string | null }
export interface RingModel {
  provider: string;
  name: string;
  plan?: string;
  /** The window closest to running out: the ring. */
  main: RingRow;
  /** Every window, the main one first. */
  rows: RingRow[];
  asOf: string;
  stale: boolean;
  paused: boolean;
  /** Banked resets the tool can spend now (Codex), or 0. */
  credits: number;
  /** Each banked reset, soonest to expire first: its id and when it expires. */
  creditList: { id: string; expires: string | null; soon: boolean }[];
  /** "Extra usage $2.51 of $1,000.00 this month" (Claude), or null. */
  spend: string | null;
  /** "83,273 credits" (Codex's prepaid balance), or null. */
  creditBalance: string | null;
}

/** Money in minor units as "$2.51"; other currencies by their code. */
export function moneyLabel(minor: number, currency: string): string {
  const v = minor / 100;
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(v); } catch { return `${v.toFixed(2)} ${currency}`; }
}
export function spendLabel(sp: UsageSummaryProvider['spend']): string | null {
  if (!sp) return null;
  const used = moneyLabel(sp.usedMinor, sp.currency);
  return sp.limitMinor ? `Extra usage ${used} of ${moneyLabel(sp.limitMinor, sp.currency)} this month` : `Extra usage ${used} this month`;
}
export function creditBalanceLabel(cb: UsageSummaryProvider['creditBalance']): string | null {
  if (!cb) return null;
  return cb.unlimited ? 'Unlimited credits' : `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(cb.balance)} credits`;
}

const SHORT: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly', seven_day_opus: 'Opus weekly', seven_day_sonnet: 'Sonnet weekly', seven_day_fable: 'Fable weekly' };

/**
 * The run-out estimate: a short label for the row ("out ~Thu 3:00 PM", "lasts to reset") and the
 * full sentence for its tooltip. Null without enough history.
 */
export function estimateLabel(w: LimitWindow, now: number, zone?: string): { short: string; long: string } | null {
  const f = w.forecast;
  if (!f) return null;
  const basis = f.basisHours >= 24 ? 'last 24 h' : `last ${f.basisHours} h`;
  if (f.lastsUntilReset || f.runsOutAt === null) return { short: 'lasts to reset', long: `At the ${basis} pace it lasts until the reset (estimate)` };
  if (f.runsOutAt <= now) return { short: 'used up', long: 'Used up' };
  const when = whenLabel(f.runsOutAt, now, zone);
  return { short: `out ~${when}`, long: `At the ${basis} pace it runs out around ${when} (estimate)` };
}

/** When a banked reset expires: "today 3:00 PM", "tomorrow 3:00 PM", "Fri 3:00 PM", or "Dec 4". */
export function expiryLabel(ms: number, now: number, zone?: string): string {
  const day = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: zone });
  const time = new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone });
  if (day(ms) === day(now)) return `today ${time}`;
  if (day(ms) === day(now + 24 * 3600_000)) return `tomorrow ${time}`;
  if (ms - now < 6 * 24 * 3600_000) return `${new Date(ms).toLocaleDateString('en-US', { weekday: 'short', timeZone: zone })} ${time}`;
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: zone });
}

/** One ring per provider that has a current figure, closest-to-empty limit on the ring. */
export function ringModels(s: UsageSummary | null, now: number, zone?: string): RingModel[] {
  if (!s) return [];
  const paused = new Set(s.paused.map((g) => g.provider));
  const out: RingModel[] = [];
  for (const p of s.providers) {
    const types = [...COUNTED.filter((t) => p.windows[t]), ...Object.keys(p.windows).filter((t) => !(COUNTED as readonly string[]).includes(t) && !HIDDEN_TYPES.has(t))];
    const rows: RingRow[] = types.map((t) => {
      const w = p.windows[t];
      const used = liveValue(w, now);
      const est = used === null ? null : estimateLabel(w, now, zone);
      return {
        type: t, label: SHORT[t] ?? TYPE_LABEL[t] ?? t,
        left: used === null ? null : Math.max(0, 100 - used),
        tone: used === null ? 'green' : ringTone(used, s.warnPercent),
        reset: w.resetsAt !== null && w.resetsAt > now ? `resets ${whenLabel(w.resetsAt, now, zone)}` : null,
        estimate: est?.short ?? null, estimateTitle: est?.long ?? null,
      };
    }).filter((r) => r.left !== null);
    if (!rows.length && !p.spend && !p.creditBalance) continue;
    rows.sort((a, b) => (a.left as number) - (b.left as number));
    out.push({
      provider: p.provider, name: PROVIDER_NAME[p.provider] ?? p.provider, plan: p.plan,
      main: rows[0] ?? { type: 'none', label: 'no limit', left: 100, tone: 'green', reset: null, estimate: null, estimateTitle: null },
      rows, asOf: `as of ${whenLabel(p.asOf, now, zone)}`, stale: now - p.asOf > STALE_MS, paused: paused.has(p.provider),
      credits: p.resetCredits?.available ?? 0,
      spend: spendLabel(p.spend), creditBalance: creditBalanceLabel(p.creditBalance),
      creditList: (p.resetCredits?.credits ?? []).map((c) => ({ id: c.id, expires: c.expiresAt === null ? null : expiryLabel(c.expiresAt, now, zone), soon: c.expiresAt !== null && c.expiresAt - now < 48 * 3600_000 })),
    });
  }
  return out;
}
