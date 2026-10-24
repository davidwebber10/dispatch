// packages/core/src/limits/snapshot.ts
// The latest usage-limit figures each provider reported. Limits belong to the account, not the
// thread, so there is one snapshot per provider, tagged with the account that reported it.
import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';

/** One limit window. `usedPercent` is null when the provider gave a reset time but no figure. */
export interface LimitWindow { usedPercent: number | null; resetsAt: number | null }
export interface LimitWindows { session?: LimitWindow; weekly?: LimitWindow; weeklyOpus?: LimitWindow }
export interface ProviderLimits extends LimitWindows { account: string; asOf: number; plan?: string }

const KEY = 'usage_limit_snapshots';
const pct = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v * 1000) / 10)) : null);
const ms = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v * 1000 : null);
const CLAUDE_WINDOWS: Record<string, keyof LimitWindows> = { five_hour: 'session', seven_day: 'weekly', seven_day_opus: 'weeklyOpus' };

/**
 * Windows from a Claude Code `rate_limit_event`'s `rate_limit_info`. `unifiedWindows` (sent once the
 * account passes a warning level) carries every window; the event's own `rateLimitType` covers the
 * plain `allowed` event, which has a reset time and no utilization. Utilization is a 0-1 fraction.
 */
export function parseClaudeRateLimit(info: any): LimitWindows {
  const out: LimitWindows = {};
  if (!info || typeof info !== 'object') return out;
  const unified = info.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows : {};
  for (const [type, w] of Object.entries(unified)) {
    const key = CLAUDE_WINDOWS[type];
    const resetsAt = ms((w as any)?.resetsAt);
    if (key && (resetsAt !== null || pct((w as any)?.utilization) !== null)) out[key] = { usedPercent: pct((w as any)?.utilization), resetsAt };
  }
  const own = CLAUDE_WINDOWS[String(info.rateLimitType ?? info.rate_limit_type)];
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
    const key: keyof LimitWindows | null = minutes > 0 && minutes <= 360 ? 'session' : minutes >= 7000 ? 'weekly' : null;
    if (key) windows[key] = { usedPercent: Math.min(100, Math.max(0, w.used_percent)), resetsAt: ms(w.resets_at) };
  }
  return { windows, plan: typeof rl.plan_type === 'string' ? rl.plan_type : undefined };
}

export class LimitSnapshots {
  private byProvider: Record<string, ProviderLimits> = {};

  constructor(private readonly db: Database.Database) {
    try { this.byProvider = JSON.parse(appState.get(db, KEY) ?? '{}') ?? {}; } catch { this.byProvider = {}; }
  }

  /** The provider's snapshot, only if it came from `account` (an unknown id on either side matches). */
  get(provider: string, account: string): ProviderLimits | null {
    const s = this.byProvider[provider];
    if (!s) return null;
    return s.account === account || !s.account || !account ? s : null;
  }

  /** Merge newly reported windows. A different account starts a fresh snapshot. */
  record(provider: string, account: string, windows: LimitWindows, now: number, plan?: string): void {
    if (!windows.session && !windows.weekly && !windows.weeklyOpus) return;
    const prior = this.get(provider, account);
    const next: ProviderLimits = { account: account || prior?.account || '', asOf: now, plan: plan ?? prior?.plan };
    for (const key of ['session', 'weekly', 'weeklyOpus'] as const) {
      const w = windows[key] ?? undefined;
      const old = prior?.[key];
      if (w) next[key] = w.usedPercent === null && old && old.resetsAt === w.resetsAt ? old : w;
      else if (old) next[key] = old;
    }
    this.byProvider[provider] = next;
    try { appState.set(this.db, KEY, JSON.stringify(this.byProvider)); } catch (err) { console.warn('[usage-limit] could not save the snapshot:', err); }
  }
}
