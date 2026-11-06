// The usage gauge's pure logic (#127): which provider the chip shows, its color, labels and
// staleness, the popover table, and the paused banner's copy. (Not `usageChip.ts`: beside
// `UsageChip.tsx` that name collides on a case-insensitive disk.)
import type { LimitWindow, UsageSummary, UsageSummaryProvider, UsagePausedGroup } from '../../api/types';
import { TYPE_LABEL, whenLabel, windowLabel } from '../inspector/usageLimits';

/** Windows that count toward the warning. Not `overage` (usage credit). Codex has the first two. */
export const COUNTED = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included'] as const;
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
  /** `C` or `X`, only when more than one provider has figures. */
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
 * The chip, or null when no provider has reported anything yet (a placeholder on a fresh
 * install is noise). Shows one provider: a paused one first (red), else the one with the
 * highest counted window. Amber when any counted window is at or above the threshold.
 */
export function chipModel(s: UsageSummary | null, now: number): ChipModel | null {
  if (!s || s.providers.length === 0) return null;
  const paused = activePaused(s, now);
  const score = (p: UsageSummaryProvider) => (paused.has(p.provider) ? 1000 : 0) + (peakWindow(p, now)?.value ?? -1);
  const pick = s.providers.reduce((a, b) => (score(b) > score(a) ? b : a));
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
    mark: s.providers.length > 1 ? MARK[pick.provider] ?? pick.provider.slice(0, 1).toUpperCase() : null,
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
    const known = Object.keys(TYPE_LABEL).filter((t) => p.windows[t]);
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
