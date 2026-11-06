// packages/core/src/limits/snapshot.ts
// The latest usage-limit figures each provider reported. Limits belong to the account, not the
// thread, so there is one snapshot per provider, tagged with the account that reported it.
import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';
import { CLI_ACCOUNT_ID } from '../auth/accounts.js';

/** One limit window. `usedPercent` is null when the provider gave a reset time but no figure. */
export interface LimitWindow { usedPercent: number | null; resetsAt: number | null }
/** Windows keyed by the provider's own limit type (`five_hour`, `seven_day`, `seven_day_overage_included`, ...). Unknown types are kept under their raw name. */
export type LimitWindows = Record<string, LimitWindow>;
/** Money and credit figures that ride with a snapshot: Claude's extra-usage spend, Codex's credit balance. */
export interface ProviderExtras {
  /** Extra usage this month, in minor units of `currency` (cents): what is spent, and the monthly cap when there is one. */
  spend?: { usedMinor: number; limitMinor: number | null; currency: string };
  /** A prepaid credit balance (Codex), in the provider's own units. */
  creditBalance?: { balance: number; unlimited: boolean };
}
export interface ProviderLimits extends ProviderExtras {
  account: string;
  /** When the newest real figure arrived. A report with a reset time and no figure does not move it. */
  asOf: number;
  plan?: string;
  windows: LimitWindows;
  /**
   * When each window's figure was read. A window kept or carried forward from an earlier report keeps its
   * old time, so an old reading is never mistaken for a new one. Missing on a snapshot saved by 3.11.0:
   * then every figure counts as read at `asOf`.
   */
  figureAt?: Record<string, number>;
}

import { addSamples, type ProviderHistory, type Sample } from './forecast.js';

const KEY = 'usage_limit_snapshots';
// Full precision (to 6 decimals, which only removes float noise): 0.9996 is 99.96, not 100. Display rounding happens later.
const pct = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v * 1e8) / 1e6)) : null);
const HISTORY_KEY = 'usage_limit_history';
const ms = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v * 1000 : null);

/**
 * Windows from a Claude Code `rate_limit_event`'s `rate_limit_info`, keyed by the CLI's own type
 * name. `unifiedWindows` carries every window the account has. CLI 2.1.316 sends it on every turn,
 * even at 46% (2.1.309 sent it only past a warning level, so older CLIs may still omit it). The
 * event's own `rateLimitType` covers a plain `allowed` event with a reset time and no utilization.
 * Utilization is a 0-1 fraction.
 */
export function parseClaudeRateLimit(info: any): LimitWindows {
  const out: LimitWindows = {};
  if (!info || typeof info !== 'object') return out;
  const unified = info.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows : {};
  for (const [type, w] of Object.entries(unified)) {
    const resetsAt = ms((w as any)?.resetsAt);
    if (resetsAt !== null || pct((w as any)?.utilization) !== null) out[type] = { usedPercent: pct((w as any)?.utilization), resetsAt };
  }
  const rawType = info.rateLimitType ?? info.rate_limit_type;
  const own = typeof rawType === 'string' && rawType ? rawType : null;
  if (own && !out[own]) {
    const resetsAt = ms(info.resetsAt ?? info.resets_at);
    const usedPercent = pct(info.utilization);
    if (resetsAt !== null || usedPercent !== null) out[own] = { usedPercent, resetsAt };
  }
  return out;
}

/** Windows from a Codex `token_count` event's `rate_limits` (percent is already 0-100, reset in epoch seconds). */
export function parseCodexRateLimits(rl: any): { windows: LimitWindows; plan?: string } {
  const windows: LimitWindows = {};
  if (!rl || typeof rl !== 'object') return { windows };
  for (const w of [rl.primary, rl.secondary]) {
    if (!w || typeof w !== 'object' || typeof w.used_percent !== 'number') continue;
    const minutes = Number(w.window_minutes);
    const key = minutes > 0 && minutes <= 360 ? 'five_hour' : minutes >= 7000 ? 'seven_day' : null;
    if (key) windows[key] = { usedPercent: Math.min(100, Math.max(0, w.used_percent)), resetsAt: ms(w.resets_at) };
  }
  return { windows, plan: typeof rl.plan_type === 'string' ? rl.plan_type : undefined };
}

export class LimitSnapshots {
  private byProvider: Record<string, ProviderLimits> = {};
  private recordListeners: ((provider: string, accountId: string) => void)[] = [];
  /** A short per-limit history for the run-out estimate (forecast.ts). */
  private historyByProvider: Record<string, ProviderHistory> = {};

  /** Told after a report changed a provider's snapshot (the usage gauge, #127), with the account it was for. */
  addRecordListener(fn: (provider: string, accountId: string) => void): void { this.recordListeners.push(fn); }

  /** The store key: the CLI login keeps the bare provider key (what earlier versions saved); an added account gets its own. */
  private static key(provider: string, accountId: string): string {
    return accountId === CLI_ACCOUNT_ID ? provider : `${provider}@${accountId}`;
  }

  constructor(private readonly db: Database.Database) {
    try { this.byProvider = JSON.parse(appState.get(db, KEY) ?? '{}') ?? {}; } catch { this.byProvider = {}; }
    try { this.historyByProvider = JSON.parse(appState.get(db, HISTORY_KEY) ?? '{}') ?? {}; } catch { this.historyByProvider = {}; }
  }

  /** The provider's samples per limit, only for exactly `account`. `accountId` picks the Dispatch account (multi-account spec). */
  history(provider: string, account: string, accountId: string = CLI_ACCOUNT_ID): Record<string, Sample[]> {
    const h = this.historyByProvider[LimitSnapshots.key(provider, accountId)];
    return h && h.account === account ? h.windows : {};
  }

  /** The provider's snapshot, only if it came from exactly `account` (an unknown id '' is an account of its own). */
  get(provider: string, account: string, accountId: string = CLI_ACCOUNT_ID): ProviderLimits | null {
    const s = this.byProvider[LimitSnapshots.key(provider, accountId)];
    return s && s.account === account ? s : null;
  }

  /**
   * Merge newly reported windows. A different account starts a fresh snapshot, and a report older
   * than the stored one is ignored (an idle thread's old figures must not undo newer ones).
   * `replace`: the report lists every window the account has (Codex), so windows it omits are gone.
   * Merged windows more than an hour past their reset are dropped, so a type reported once does not linger.
   * Returns false when the report was ignored.
   */
  record(provider: string, account: string, windows: LimitWindows, now: number, plan?: string, replace = false, extras?: ProviderExtras, accountId: string = CLI_ACCOUNT_ID): boolean {
    if (!replace && Object.keys(windows).length === 0) return false;
    const key = LimitSnapshots.key(provider, accountId);
    const prior = this.get(provider, account, accountId);
    if (prior && now < prior.asOf) return false;
    const merged: LimitWindows = replace ? {} : { ...(prior?.windows ?? {}) };
    // Figure times: carried forward for kept windows, now for a real new figure, none for a window with no figure.
    const figureAt: Record<string, number> = {};
    if (!replace) for (const type of Object.keys(merged)) { const at = prior?.figureAt?.[type] ?? prior?.asOf; if (at !== undefined && merged[type].usedPercent !== null) figureAt[type] = at; }
    let realFigure = false;
    for (const [type, w] of Object.entries(windows)) {
      const old = prior?.windows[type];
      const keep = w.usedPercent === null && old && old.resetsAt === w.resetsAt;
      merged[type] = keep ? old : w;
      if (keep) { const at = prior?.figureAt?.[type] ?? prior?.asOf; if (at !== undefined && old.usedPercent !== null) figureAt[type] = at; else delete figureAt[type]; }
      else if (w.usedPercent !== null) { figureAt[type] = now; realFigure = true; }
      else delete figureAt[type];
    }
    for (const [type, w] of Object.entries(merged)) if (w.resetsAt !== null && w.resetsAt < now - 3600_000) { delete merged[type]; delete figureAt[type]; }
    // asOf moves only for a real new figure (the first report of an account starts it at `now` either way).
    this.byProvider[key] = {
      account, asOf: realFigure || !prior ? now : prior.asOf, plan: plan ?? prior?.plan, windows: merged, figureAt,
      // Extras carry forward until a report brings new ones (a stream event has none; the usage read has them).
      ...((extras?.spend ?? prior?.spend) ? { spend: extras?.spend ?? prior?.spend } : {}),
      ...((extras?.creditBalance ?? prior?.creditBalance) ? { creditBalance: extras?.creditBalance ?? prior?.creditBalance } : {}),
    };
    try { appState.set(this.db, KEY, JSON.stringify(this.byProvider)); } catch (err) { console.warn('[usage-limit] could not save the snapshot:', err); }
    this.historyByProvider[key] = addSamples(this.historyByProvider[key], account, windows, now);
    try { appState.set(this.db, HISTORY_KEY, JSON.stringify(this.historyByProvider)); } catch (err) { console.warn('[usage-limit] could not save the history:', err); }
    for (const fn of this.recordListeners) {
      try { fn(provider, accountId); } catch (err) { console.warn('[usage-limit] a snapshot listener failed:', err); }
    }
    return true;
  }
}
