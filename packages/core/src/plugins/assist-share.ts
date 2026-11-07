import type Database from 'better-sqlite3';
import { priceFor, type ModelPrice } from '../analytics/pricing.js';
import type { UsageSummary, SummaryProvider } from '../limits/gauge.js';
import type { AssistHarness, AssistPick } from '../assist/run.js';

/**
 * A plugin's share of a usage limit (coach spec section 7.3), and the account `auto` runs on
 * (section 5, Model → Automatic).
 *
 * The share is an estimate: the plugin's model calls on an account in a window, over every
 * Dispatch token on that account in the window (thread turns and every plugin's calls), times the
 * window's used percent. Tokens are weighted by model price, so a Haiku call weighs less than an
 * Opus turn. Usage outside Dispatch is not seen, so the estimate reads high: a budget built on it
 * stops early, never late (section 9a.3).
 */
export type ShareWindow = 'five_hour' | 'seven_day';
export interface ShareEstimate {
  /** The window's used percent, as the provider reports it. */
  usedPercent: number;
  /** The plugin's estimated part of `usedPercent`. */
  pluginPercent: number;
  /** Exact counts beside the estimate (input + output + cache tokens). */
  pluginTokens: number;
  accountTokens: number;
  resetsAt: string | null;
  /** The price-weighted sums behind `pluginPercent` (micro-dollars at list price), for a reservation in the same units. */
  pluginWeight: number;
  accountWeight: number;
}

/** Tokens weighted by the model's list price (micro-dollars); a model with no known price weighs as Sonnet. */
export function tokenWeight(model: string | null | undefined, t: { input: number; output: number; cacheRead?: number; cacheCreate?: number }): number {
  return weightOf({ model: model ?? null, i: t.input, o: t.output, cr: t.cacheRead ?? 0, cc: t.cacheCreate ?? 0 });
}

const WINDOW_MS: Record<ShareWindow, number> = { five_hour: 5 * 3_600_000, seven_day: 7 * 86_400_000 };
/**
 * The fail-safe cap when an account's weekly window is unknown (no usage figures yet, a poll gap
 * after a restart): a percent budget becomes at most this many tokens a week for each percent.
 * 3% = 150,000 tokens. Tokens are input, output and cache writes; a cache read counts one tenth.
 */
export const WEEKLY_TOKENS_PER_PERCENT = 50_000;
/** Never take the last 10% of a 5-hour window (section 9a.2). */
export const FIVE_HOUR_FLOOR_PERCENT = 90;
/** A model with no known price weighs as Sonnet does: a middle price, the same for the plugin and the threads. */
const FALLBACK_PRICE: ModelPrice = priceFor('sonnet')!;

/** The usage-summary provider for a harness. OpenRouter has no limits. */
export const summaryProviderOf = (harness: AssistHarness): string | null => (harness === 'claude' ? 'claude-code' : harness === 'codex' ? 'codex' : null);
/** The assist harness for a thread provider. */
const threadProviderOf = (harness: AssistHarness): string | null => summaryProviderOf(harness);

interface TokenRow { model: string | null; i: number; o: number; cr: number; cc: number }
const weightOf = (r: TokenRow): number => {
  const p = priceFor(r.model ?? '') ?? FALLBACK_PRICE;
  return r.i * p.input + r.o * p.output + r.cr * p.cacheRead + r.cc * p.cacheCreate;
};
const tokensOf = (r: TokenRow): number => r.i + r.o + r.cr + r.cc;

function findProvider(summary: UsageSummary | null | undefined, harness: AssistHarness, accountId: string): SummaryProvider | null {
  const provider = summaryProviderOf(harness);
  if (!summary || !provider) return null;
  return summary.providers.find((p) => p.provider === provider && p.accountId === accountId) ?? null;
}

export function estimateShare(db: Database.Database, summary: UsageSummary | null | undefined, opts: {
  pluginId: string;
  accountId: string;
  window: ShareWindow;
  /** Which subscription the account belongs to. Default: Claude. */
  harness?: AssistHarness;
  /** The harness's default account: a thread pinned to no account runs on it. Default: `cli`. */
  defaultAccountId?: string;
  now?: number;
}): ShareEstimate | null {
  const harness = opts.harness ?? 'claude';
  const now = opts.now ?? Date.now();
  const w = findProvider(summary, harness, opts.accountId)?.windows[opts.window];
  if (!w || typeof w.usedPercent !== 'number') return null;
  const resetsAt = typeof w.resetsAt === 'number' ? w.resetsAt : null;
  const since = new Date((resetsAt ?? now) - WINDOW_MS[opts.window]).toISOString();

  // Every plugin's calls on this account in the window.
  const calls = db.prepare(`SELECT plugin_id AS pluginId, model, input_tokens AS i, output_tokens AS o,
      COALESCE(cache_read_tokens, 0) AS cr, COALESCE(cache_create_tokens, 0) AS cc
    FROM plugin_assist WHERE harness = ? AND account_id = ? AND at >= ? AND COALESCE(ok, 1) = 1`)
    .all(harness, opts.accountId, since) as (TokenRow & { pluginId: string })[];
  // Every thread turn on this account in the window: pinned to it, or pinned to none while it is the default.
  const threadProvider = threadProviderOf(harness);
  const isDefault = (opts.defaultAccountId ?? 'cli') === opts.accountId;
  const turns = threadProvider ? db.prepare(`SELECT u.model AS model, u.input_tokens AS i, u.output_tokens AS o, u.cache_read_tokens AS cr, u.cache_create_tokens AS cc
    FROM usage_turns u LEFT JOIN terminals t ON t.id = u.terminal_id
    WHERE u.provider = ? AND u.started_at >= ?
      AND (json_extract(COALESCE(t.config, '{}'), '$.accountId') = ?
        OR (? = 1 AND COALESCE(json_extract(COALESCE(t.config, '{}'), '$.accountId'), '') = ''))`)
    .all(threadProvider, since, opts.accountId, isDefault ? 1 : 0) as TokenRow[] : [];

  let pluginW = 0; let pluginTokens = 0; let accountW = 0; let accountTokens = 0;
  for (const c of calls) {
    const wgt = weightOf(c); const n = tokensOf(c);
    accountW += wgt; accountTokens += n;
    if (c.pluginId === opts.pluginId) { pluginW += wgt; pluginTokens += n; }
  }
  for (const t of turns) { accountW += weightOf(t); accountTokens += tokensOf(t); }
  const pluginPercent = accountW > 0 ? (pluginW / accountW) * w.usedPercent : 0;
  return { usedPercent: w.usedPercent, pluginPercent, pluginTokens, accountTokens, resetsAt: resetsAt === null ? null : new Date(resetsAt).toISOString(), pluginWeight: pluginW, accountWeight: accountW };
}

/** A window's used percent now: null when unknown; 0 when its reset has passed (the figure is from the last window). */
function usedNow(p: SummaryProvider | null, window: ShareWindow, now: number): number | null {
  const w = p?.windows[window];
  if (!w || typeof w.usedPercent !== 'number') return null;
  if (typeof w.resetsAt === 'number' && w.resetsAt <= now) return 0;
  return w.usedPercent;
}

/**
 * The harness and account `auto` runs on: the subscription account with the most room in its
 * weekly window, skipping any at or past 90% of its 5-hour window. An account the summary does
 * not know ranks below one it knows. With no figures for any account (no summary, no Claude
 * login read yet, a Codex poll gap after a restart): the first signed-in one, `no usage data`.
 * OpenRouter (no limit) only when no subscription account may run. Null when nothing may run.
 */
export function pickHarness(summary: UsageSummary | null | undefined, signedIn: { harness: AssistHarness; accountId: string }[], now = Date.now()): AssistPick | null {
  const subs = signedIn.filter((s) => s.harness !== 'openrouter');
  const router = signedIn.find((s) => s.harness === 'openrouter') ?? null;
  const known = subs.map((s) => {
    const p = findProvider(summary, s.harness, s.accountId);
    return { s, five: usedNow(p, 'five_hour', now), week: usedNow(p, 'seven_day', now), seen: !!p };
  });
  if (!known.some((k) => k.seen)) {
    const first = subs[0] ?? router;
    return first ? { harness: first.harness, accountId: first.accountId, reason: 'no usage data' } : null;
  }
  const open = known.filter((k) => k.five === null || k.five < FIVE_HOUR_FLOOR_PERCENT);
  // Most weekly room first; an unknown week ranks below every known one; ties keep the given order.
  const room = (k: (typeof known)[number]): number => (k.week === null ? (k.five === null ? -2 : -1) : 100 - k.week);
  let best: (typeof known)[number] | null = null;
  for (const k of open) if (!best || room(k) > room(best)) best = k;
  if (best) {
    const why = best.week !== null ? `most weekly room (${Math.round(100 - best.week)}% left)` : best.five !== null ? 'no weekly figure; under the 5-hour floor' : 'no usage data for this account';
    return { harness: best.s.harness, accountId: best.s.accountId, reason: why };
  }
  if (router) return { harness: 'openrouter', accountId: router.accountId, reason: 'every subscription is near its 5-hour limit' };
  return null;
}
