// packages/core/src/limits/gauge.ts
// The usage gauge (#127): one account-wide summary of every provider's limit figures and every
// thread paused on a limit, for the header chip and the paused banner. Owns the throttled
// `usage-limits` broadcast, the one-push-per-window threshold alert, and the Codex refresh tick.
// No overseer imports: a future coordinator spawn guard calls nearLimit() and activePauses().
import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';
import * as parksDb from '../db/usage-limits.js';
import * as terminalsDb from '../db/terminals.js';
import * as gaugeSettings from './gauge-settings.js';
import { CHAT_ID } from './service.js';
import type { LimitSnapshots, LimitWindows } from './snapshot.js';

export const PROVIDERS = ['claude-code', 'codex'] as const;
/** Windows that count toward the warning. Not `overage` (usage credit). Codex has the first two. */
export const COUNTED = new Set(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included']);
const WINDOW_NAME: Record<string, string> = {
  five_hour: 'Session (5h)', seven_day: 'Weekly', seven_day_opus: 'Opus weekly', seven_day_sonnet: 'Sonnet weekly', seven_day_overage_included: 'Fable weekly',
};
const PROVIDER_NAME: Record<string, string> = { 'claude-code': 'Claude', codex: 'Codex' };
const WEEKLY_KINDS = new Set(['weekly', 'fable', 'opus', 'sonnet']);
const ALERTS_KEY = 'usage_limit_alerts';
const MIN = 60_000;
const DEFAULTS = {
  /** At most one broadcast per this gap (trailing edge). A pause or settings change skips the wait. */
  throttleMs: 5000,
  tickMs: 60_000,
  /** Refresh Codex figures only when a Codex thread was active this recently. */
  codexActiveMs: 10 * MIN,
  /** A null reset time keeps its alert key this long. */
  nullResetTtlMs: 7 * 24 * 60 * MIN,
};

export interface SummaryWindow { usedPercent: number | null; resetsAt: number | null }
export interface SummaryProvider { provider: string; plan?: string; asOf: number; windows: Record<string, SummaryWindow> }
export interface PausedGroup {
  provider: string;
  kind: string;
  earliestResetsAt: number | null;
  /** Paused and capped rows together. Chat's own park counts as one. */
  threads: number;
  capped: number;
  /** Chat's own turn is among the paused. */
  chat: boolean;
  /** The first paused thread for the banner's click (CHAT_ID when Chat is the only one). */
  firstTerminalId: string;
  firstSessionId: string | null;
  /** The earliest parked_at: keys the per-device dismiss. */
  episodeStartedAt: number;
}
export interface UsageSummary { type: 'usage-limits'; warnPercent: number; providers: SummaryProvider[]; paused: PausedGroup[] }

export interface PushTarget { notifyAccount(input: { title: string; body: string; tag: string }): Promise<void> }

export interface GaugeDeps {
  db: Database.Database;
  snapshots: LimitSnapshots;
  broadcast: (event: Record<string, unknown>) => void;
  push?: PushTarget | null;
  accountFor: (provider: string) => string;
  /** Codex writes its limits into the session file: read the newest for one thread (throttled by its owner). */
  refreshCodex?: (terminalId: string, externalId: string | null) => void;
  now?: () => number;
  /** The zone the push shows the reset time in. Default: this machine. */
  zone?: string;
  options?: Partial<typeof DEFAULTS>;
}

/** A window that still holds a figure: past its reset it shows `–` and never counts. */
const live = (w: SummaryWindow, now: number): boolean => w.usedPercent !== null && (w.resetsAt === null || w.resetsAt > now);

export class UsageGauge {
  private readonly o: typeof DEFAULTS;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private pending: NodeJS.Timeout | null = null;
  private lastSent = '';

  constructor(private readonly d: GaugeDeps) {
    this.o = { ...DEFAULTS, ...d.options };
    this.now = d.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.tick(); } catch (err) { console.warn('[usage-gauge] tick failed:', err); } }, this.o.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.pending) clearTimeout(this.pending);
    this.timer = null;
    this.pending = null;
  }

  settings(): gaugeSettings.UsageLimitSettings { return gaugeSettings.get(this.d.db); }

  /** The current account's windows for one provider, percents rounded to integers. Null with no snapshot. */
  private providerSummary(provider: string): (SummaryProvider & { account: string }) | null {
    const s = this.d.snapshots.get(provider, this.d.accountFor(provider));
    if (!s) return null;
    const windows: Record<string, SummaryWindow> = {};
    for (const [type, w] of Object.entries(s.windows as LimitWindows)) {
      windows[type] = { usedPercent: w.usedPercent === null ? null : Math.round(w.usedPercent), resetsAt: w.resetsAt };
    }
    return { provider, account: s.account, plan: s.plan, asOf: s.asOf, windows };
  }

  /** Paused threads grouped by provider, from the park rows in `parked` or `capped`. */
  private pausedGroups(): PausedGroup[] {
    const by = new Map<string, parksDb.ParkRow[]>();
    for (const r of parksDb.listPaused(this.d.db)) by.set(r.provider, [...(by.get(r.provider) ?? []), r]);
    const out: PausedGroup[] = [];
    for (const [provider, rows] of by) {
      // Mixed kinds: weekly beats session, then the latest pause wins.
      const latest = [...rows].sort((a, b) => b.parked_at - a.parked_at);
      const kind = (latest.find((r) => WEEKLY_KINDS.has(r.kind)) ?? latest[0]).kind;
      const resets = rows.filter((r) => r.state === 'parked' && r.resets_at !== null).map((r) => r.resets_at as number);
      const first = rows.find((r) => r.terminal_id !== CHAT_ID) ?? rows[0];
      const firstSessionId = first.terminal_id === CHAT_ID ? null : terminalsDb.getById(this.d.db, first.terminal_id)?.session_id ?? null;
      out.push({
        provider, kind,
        earliestResetsAt: resets.length ? Math.min(...resets) : null,
        threads: rows.length,
        capped: rows.filter((r) => r.state === 'capped').length,
        chat: rows.some((r) => r.terminal_id === CHAT_ID),
        firstTerminalId: first.terminal_id,
        firstSessionId,
        episodeStartedAt: Math.min(...rows.map((r) => r.parked_at)),
      });
    }
    return out;
  }

  summary(): UsageSummary {
    const providers: SummaryProvider[] = [];
    for (const p of PROVIDERS) {
      const s = this.providerSummary(p);
      if (s) { const { account: _account, ...rest } = s; providers.push(rest); }
    }
    return { type: 'usage-limits', warnPercent: this.settings().warnPercent, providers, paused: this.pausedGroups() };
  }

  /** The highest counted window at or above the threshold, or null. For a future spawn guard (ledger N8). */
  nearLimit(provider: string): { windowType: string; usedPercent: number; resetsAt: number | null } | null {
    const s = this.providerSummary(provider);
    if (!s) return null;
    const warn = this.settings().warnPercent;
    const now = this.now();
    let best: { windowType: string; usedPercent: number; resetsAt: number | null } | null = null;
    for (const [type, w] of Object.entries(s.windows)) {
      if (!COUNTED.has(type) || !live(w, now) || w.usedPercent! < warn) continue;
      if (!best || w.usedPercent! > best.usedPercent) best = { windowType: type, usedPercent: w.usedPercent!, resetsAt: w.resetsAt };
    }
    return best;
  }

  /** The provider's threads stopped on a limit right now (parked or capped). For a future spawn guard (ledger N8). */
  activePauses(provider: string): parksDb.ParkRow[] {
    return parksDb.listPaused(this.d.db).filter((r) => r.provider === provider);
  }

  // --- the one-push-per-window alert -------------------------------------------------------

  private alertKey(provider: string, account: string, type: string, resetsAt: number | null): string {
    // Rounded to 10 minutes: the reset time can jitter between events of one window.
    const r = resetsAt === null ? 'none' : String(Math.round(resetsAt / (10 * MIN)) * 10 * MIN);
    return `${provider}|${account}|${type}|${r}`;
  }

  private loadAlerts(): Record<string, number> {
    try {
      const v = JSON.parse(appState.get(this.d.db, ALERTS_KEY) ?? '{}');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch { return {}; }
  }

  private saveAlerts(alerts: Record<string, number>, now: number): void {
    for (const [k, exp] of Object.entries(alerts)) if (typeof exp !== 'number' || exp < now) delete alerts[k];
    try { appState.set(this.d.db, ALERTS_KEY, JSON.stringify(alerts)); } catch (err) { console.warn('[usage-gauge] could not save alert keys:', err); }
  }

  /** Windows of `provider` at or above the threshold that have not alerted yet in their window. Marks them alerted. */
  private crossings(provider: string): { type: string; w: SummaryWindow }[] {
    const s = this.providerSummary(provider);
    if (!s) return [];
    const warn = this.settings().warnPercent;
    const now = this.now();
    const alerts = this.loadAlerts();
    const out: { type: string; w: SummaryWindow }[] = [];
    for (const [type, w] of Object.entries(s.windows)) {
      if (!COUNTED.has(type) || !live(w, now) || w.usedPercent! < warn) continue;
      const key = this.alertKey(provider, s.account, type, w.resetsAt);
      if (key in alerts) continue;
      alerts[key] = w.resetsAt ?? now + this.o.nullResetTtlMs;
      out.push({ type, w });
    }
    if (out.length) this.saveAlerts(alerts, now);
    return out;
  }

  private clock(ms: number): string {
    const now = this.now();
    let zone: string | undefined = this.d.zone;
    try { if (zone) new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch { zone = undefined; }
    const time = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
    if (ms - now < 24 * 60 * MIN - MIN) return time;
    return `${new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' }).format(new Date(ms))} ${time}`;
  }

  private sendPushes(provider: string, list: { type: string; w: SummaryWindow }[]): void {
    if (!list.length || !this.settings().pushOnWarn || !this.d.push) return;
    for (const { type, w } of list) {
      // Template only: no model content ever goes into a push.
      const title = `${PROVIDER_NAME[provider] ?? provider} usage at ${w.usedPercent}%`;
      const body = `${WINDOW_NAME[type] ?? type} window${w.resetsAt === null ? '' : `, resets ${this.clock(w.resetsAt)}`}.`;
      this.d.push.notifyAccount({ title, body, tag: `usage-${provider}-${type}` }).catch((err) => console.warn('[usage-gauge] push failed:', err));
    }
  }

  // --- inputs -------------------------------------------------------------------------------

  /** A provider's snapshot changed: alert on a new crossing, then broadcast (throttled). */
  onRecord(provider: string): void {
    this.sendPushes(provider, this.crossings(provider));
    this.schedule();
  }

  /** A pause started or ended: broadcast at once. */
  pausesChanged(): void { this.flush(); }

  /**
   * The settings changed. Never pushes by itself: every window already at or above the new level
   * is marked alerted for its current window. Then broadcast at once, so every client recolors.
   */
  settingsChanged(): void {
    for (const p of PROVIDERS) this.crossings(p);
    this.flush();
  }

  /** 60 s: refresh Codex from its most recently active thread, if one was active in the last 10 minutes. */
  tick(): void {
    if (!this.d.refreshCodex) return;
    const since = new Date(this.now() - this.o.codexActiveMs).toISOString();
    const row = this.d.db.prepare(
      "SELECT id, external_id FROM terminals WHERE type = 'codex' AND archived_at IS NULL AND external_id IS NOT NULL AND last_activity_at >= ? ORDER BY last_activity_at DESC LIMIT 1",
    ).get(since) as { id: string; external_id: string } | undefined;
    if (row) this.d.refreshCodex(row.id, row.external_id);
  }

  // --- the throttled broadcast --------------------------------------------------------------

  private schedule(): void {
    if (this.pending) return;
    this.pending = setTimeout(() => { this.pending = null; this.send(); }, this.o.throttleMs);
    this.pending.unref?.();
  }

  private flush(): void {
    if (this.pending) { clearTimeout(this.pending); this.pending = null; }
    this.send();
  }

  /**
   * Send only when the payload changed. Percents are already integers. `asOf` moves on every turn,
   * so it is compared at 5-minute grain: enough for the client's 30-minute staleness dim.
   */
  private send(): void {
    let summary: UsageSummary;
    try { summary = this.summary(); } catch (err) { console.warn('[usage-gauge] summary failed:', err); return; }
    const key = JSON.stringify({ ...summary, providers: summary.providers.map((p) => ({ ...p, asOf: Math.floor(p.asOf / (5 * MIN)) })) });
    if (key === this.lastSent) return;
    this.lastSent = key;
    this.d.broadcast(summary as unknown as Record<string, unknown>);
  }
}
