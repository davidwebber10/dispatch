// packages/core/src/limits/gauge.ts
// The usage gauge (#127): one account-wide summary of every provider's limit figures and every
// thread paused on a limit, for the header chip and the paused banner. Owns the throttled
// `usage-limits` broadcast, the one-push-per-window threshold alert, and the Codex refresh tick.
// No overseer imports: a future coordinator spawn guard calls nearLimit() and activePauses().
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import * as appState from '../db/app-state.js';
import * as parksDb from '../db/usage-limits.js';
import * as terminalsDb from '../db/terminals.js';
import * as gaugeSettings from './gauge-settings.js';
import { CHAT_ID } from './service.js';
import type { LimitSnapshots, LimitWindows } from './snapshot.js';
import type { LimitKind } from './detect.js';

export const PROVIDERS = ['claude-code', 'codex'] as const;
/** Windows that count toward the warning. Not `overage` (usage credit). Codex has the first two. */
export const COUNTED = new Set(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included']);
const WINDOW_NAME: Record<string, string> = {
  five_hour: 'Session (5h)', seven_day: 'Weekly', seven_day_opus: 'Opus weekly', seven_day_sonnet: 'Sonnet weekly', seven_day_overage_included: 'Fable weekly',
};
import { forecast, type Forecast } from './forecast.js';
import type { ResetCredits } from './codex-poll.js';

const PROVIDER_NAME: Record<string, string> = { 'claude-code': 'Claude', codex: 'Codex' };
const WEEKLY_KINDS = new Set(['weekly', 'fable', 'opus', 'sonnet']);
/** The usage window each limit kind is about. `usage` (a limit the CLI did not name) has none: any counted window then counts. */
const LIMITED_WINDOW: Partial<Record<LimitKind, string>> = {
  session: 'five_hour', weekly: 'seven_day', opus: 'seven_day_opus', sonnet: 'seven_day_sonnet', fable: 'seven_day_overage_included',
};
const ALERTS_KEY = 'usage_limit_alerts';
const MIN = 60_000;
const DEFAULTS = {
  /** At most one broadcast per this gap (trailing edge). A pause or settings change skips the wait. */
  throttleMs: 5000,
  tickMs: 60_000,
  /** Refresh Codex figures from a thread active this recently, or one still working. */
  codexActiveMs: 10 * MIN,
  /** At most this many Codex threads per tick. Each read is throttled per thread by its owner. */
  codexRefreshMax: 4,
  /** Two reset times this close are the same limit window (the CLI's reset time jitters by seconds). */
  sameWindowMs: 10 * MIN,
  /** With no active Codex thread, ask Codex directly at most this often. */
  codexPollMs: 5 * MIN,
  /** Claude figures older than this get a background probe (a Pretty thread's turns keep them fresher). */
  claudeStaleMs: 5 * MIN,
  /** ...but only while something was active this recently: an idle machine is not probed. */
  claudeIdleMs: 30 * MIN,
  /** A null reset time keeps its alert key this long. */
  nullResetTtlMs: 7 * 24 * 60 * MIN,
};

export interface SummaryWindow { usedPercent: number | null; resetsAt: number | null; forecast?: Forecast | null }
export interface SummaryProvider { provider: string; plan?: string; asOf: number; windows: Record<string, SummaryWindow>; resetCredits?: ResetCredits }
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
  /** The earliest parked_at. */
  episodeStartedAt: number;
  /** The newest parked_at: a pause newer than a device's dismiss shows the banner again. */
  latestStartedAt: number;
  /**
   * When the limit stops holding the group back, so the chip is no longer red: the latest reset
   * over its rows. A row with no readable reset has no end time: the limit holds until the thread
   * resumes (the row goes away) or fresh figures for the provider, taken after the pause, show every
   * counted window under 100% (then the end is when those figures were taken). Null while any row is
   * still in that state, and the chip stays red. A failed wake stamps its row (a send failure is not
   * the limit). The retry timing (30 minutes, 6 hours) does not change this. The banner still lists it.
   */
  activeUntil: number | null;
}
export interface UsageSummary {
  type: 'usage-limits';
  /** When the daemon built this summary (ms). Informational: clients order by (epoch, rev), not by this clock. */
  at: number;
  /**
   * A random id made once per daemon start. A client orders summaries by (epoch, rev): a new
   * epoch always lands and resets its floor, so a restart whose clock went back is never ignored.
   */
  epoch: string;
  /**
   * Rises on every summary of this epoch, the GET answer and the broadcast alike. A client keeps
   * the highest it has seen in the epoch, so an older answer that lands late never wins.
   */
  rev: number;
  warnPercent: number;
  /** The daemon-wide push switch, so every open Settings follows a change made on another device. */
  pushOnWarn: boolean;
  providers: SummaryProvider[];
  paused: PausedGroup[];
}

export interface PushTarget { notifyAccount(input: { title: string; body: string; tag: string }): Promise<void> }

export interface GaugeDeps {
  db: Database.Database;
  snapshots: LimitSnapshots;
  broadcast: (event: Record<string, unknown>) => void;
  push?: PushTarget | null;
  accountFor: (provider: string) => string;
  /** Codex writes its limits into the session file: read the newest for one thread (throttled by its owner). */
  refreshCodex?: (terminalId: string, externalId: string | null) => void;
  /** Ask Codex itself for its limits (codex-poll.ts): used when no Codex thread was active lately. */
  pollCodex?: () => Promise<boolean>;
  /** Codex's banked limit resets, from the last direct read. */
  codexCredits?: () => ResetCredits | null;
  /** Run one tiny Claude turn to read the account's windows (claude-probe.ts), for when no Pretty thread reports. */
  probeClaude?: () => Promise<boolean>;
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
  /** The soonest `runsOutAt` still ahead when last sent, or null. Once the clock passes it, send again (see send). */
  private resendAt: number | null = null;
  private rev = 0;
  private readonly epoch = randomUUID();
  /** When the tick last asked to refresh each Codex thread, for the least-recently-polled rotation. */
  private readonly polledAt = new Map<string, number>();

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
  private providerSummary(provider: string): (SummaryProvider & { account: string; figureAt: Record<string, number>; raw: Record<string, number | null> }) | null {
    const s = this.d.snapshots.get(provider, this.d.accountFor(provider));
    if (!s) return null;
    const windows: Record<string, SummaryWindow> = {};
    const raw: Record<string, number | null> = {}; // the unrounded figures: 99.6 shows as 100 but is not at the limit
    const history = this.d.snapshots.history(provider, s.account);
    const now = this.now();
    for (const [type, w] of Object.entries(s.windows as LimitWindows)) {
      raw[type] = w.usedPercent;
      const f = forecast(history[type], w, now);
      windows[type] = { usedPercent: w.usedPercent === null ? null : Math.round(w.usedPercent), resetsAt: w.resetsAt, ...(f ? { forecast: f } : {}) };
    }
    const credits = provider === 'codex' ? this.d.codexCredits?.() ?? null : null;
    return { provider, account: s.account, plan: s.plan, asOf: s.asOf, windows, figureAt: s.figureAt ?? {}, raw, ...(credits && credits.available > 0 ? { resetCredits: credits } : {}) };
  }

  /** The park rows in `parked` or `capped`, without those of an archived thread: it can never resume, so it is not paused. */
  private pausedRows(): parksDb.ParkRow[] {
    return parksDb.listPaused(this.d.db).filter((r) => r.terminal_id === CHAT_ID || !terminalsDb.getById(this.d.db, r.terminal_id)?.archived_at);
  }

  /**
   * When one paused row's limit ends: its read reset, else when fresh figures showed the window clear,
   * else null (unknown, still holding). Fresh means taken after the limit was last detected for the
   * row (a resume that hits it again renews that), and clear means at least one live counted window
   * with a real figure and none of them at 100%. No figure, a null percentage, or only windows past
   * their reset is unknown, never clear.
   */
  private rowEnd(r: parksDb.ParkRow): number | null {
    if (r.resets_at !== null) return r.resets_at;
    // Seen to clear under this detection: it stays clear (the clearing reading expiring or a restart changes nothing) until a new detection.
    if (r.cleared_at !== null && r.cleared_at > r.detected_at) return r.cleared_at;
    const end = this.freshClearEnd(r);
    if (end !== null) {
      try { parksDb.markCleared(this.d.db, r.terminal_id, r.detected_at, end); } catch (err) { console.warn('[usage-gauge] could not keep the cleared mark:', err); }
    }
    return end;
  }

  /** The time of the reading that shows the row's limit clear, or null. */
  private freshClearEnd(r: parksDb.ParkRow): number | null {
    const s = this.providerSummary(r.provider);
    if (!s) return null;
    const now = this.now();
    // The window the limit was about: only a reading of that window can clear it (another window under 100% says nothing).
    // A limit the CLI did not name (kind usage) has no window, so any counted window counts, as before.
    const named = LIMITED_WINDOW[r.kind];
    const figures = Object.entries(s.windows).filter(([type, w]) => (named ? type === named : COUNTED.has(type)) && live(w, now));
    // Any such live window at the limit holds it, old reading or not. Compared unrounded.
    if (figures.some(([type]) => (s.raw[type] ?? 0) >= 100)) return null;
    // A weekly limit may really have been a per-model one ("Opus weekly limit" reads as weekly): any weekly window at the limit holds it too.
    if (r.kind === 'weekly' && Object.entries(s.windows).some(([type, w]) => type.startsWith('seven_day') && COUNTED.has(type) && live(w, now) && (s.raw[type] ?? 0) >= 100)) return null;
    // A new reading is a window whose own figure was read after the detection: a kept or carried-forward old figure is not one.
    const times = figures.map(([type]) => s.figureAt[type] ?? s.asOf).filter((at) => at > r.detected_at);
    return times.length ? Math.max(...times) : null;
  }

  /** Paused threads grouped by provider, from the park rows in `parked` or `capped`. */
  private pausedGroups(): PausedGroup[] {
    const by = new Map<string, parksDb.ParkRow[]>();
    for (const r of this.pausedRows()) by.set(r.provider, [...(by.get(r.provider) ?? []), r]);
    const out: PausedGroup[] = [];
    for (const [provider, rows] of by) {
      // Mixed kinds: weekly beats session, then the latest pause wins.
      const latest = [...rows].sort((a, b) => b.parked_at - a.parked_at);
      const kind = (latest.find((r) => WEEKLY_KINDS.has(r.kind)) ?? latest[0]).kind;
      const resets = rows.filter((r) => r.state === 'parked' && r.resets_at !== null).map((r) => r.resets_at as number);
      const ends = rows.map((r) => this.rowEnd(r));
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
        latestStartedAt: Math.max(...rows.map((r) => r.parked_at)),
        activeUntil: ends.includes(null) ? null : Math.max(...(ends as number[])),
      });
    }
    return out;
  }

  summary(): UsageSummary {
    const providers: SummaryProvider[] = [];
    for (const p of PROVIDERS) {
      const s = this.providerSummary(p);
      if (s) { const { account: _account, figureAt: _figureAt, raw: _raw, ...rest } = s; providers.push(rest); }
    }
    const settings = this.settings();
    const at = this.now();
    this.rev = Math.max(at, this.rev + 1);
    return { type: 'usage-limits', at, epoch: this.epoch, rev: this.rev, warnPercent: settings.warnPercent, pushOnWarn: settings.pushOnWarn, providers, paused: this.pausedGroups() };
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
    return this.pausedRows().filter((r) => r.provider === provider);
  }

  // --- the one-push-per-window alert -------------------------------------------------------

  private alertKey(provider: string, account: string, type: string, resetsAt: number | null): string {
    return `${provider}|${account}|${type}|${resetsAt === null ? 'none' : resetsAt}`;
  }

  /** The stored key of the same limit window, or null. The reset time jitters between events, so any stored reset within `sameWindowMs` counts as the same window. */
  private alertedKey(alerts: Record<string, number>, provider: string, account: string, type: string, resetsAt: number | null): string | null {
    const prefix = `${provider}|${account}|${type}|`;
    for (const k of Object.keys(alerts)) {
      if (!k.startsWith(prefix)) continue;
      const r = k.slice(prefix.length);
      if (resetsAt === null ? r === 'none' : r !== 'none' && Math.abs(Number(r) - resetsAt) <= this.o.sameWindowMs) return k;
    }
    return null;
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
      if (this.alertedKey(alerts, provider, s.account, type, w.resetsAt)) continue;
      const key = this.alertKey(provider, s.account, type, w.resetsAt);
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

  private lastCodexPoll = -Infinity;
  private codexPolling = false;
  private lastClaudeProbe = -Infinity;
  private claudeProbing = false;

  /**
   * Keep Claude's figures current without a Pretty thread: when the last report is older than
   * claudeStaleMs and some thread was active within claudeIdleMs, run one probe (at most one per
   * claudeStaleMs). A Pretty thread in use keeps the figures fresh, so then it never runs.
   */
  private maybeProbeClaude(): void {
    if (!this.d.probeClaude || this.claudeProbing) return;
    const now = this.now();
    if (now - this.lastClaudeProbe < this.o.claudeStaleMs) return;
    const s = this.d.snapshots.get('claude-code', this.d.accountFor('claude-code'));
    if (s && now - s.asOf < this.o.claudeStaleMs) return;
    const since = new Date(now - this.o.claudeIdleMs).toISOString();
    const active = this.d.db.prepare('SELECT 1 FROM terminals WHERE archived_at IS NULL AND last_activity_at >= ? LIMIT 1').get(since);
    if (!active) return;
    this.lastClaudeProbe = now;
    this.claudeProbing = true;
    void this.d.probeClaude().catch(() => false).finally(() => { this.claudeProbing = false; });
  }

  /**
   * 60 s: refresh Codex from its threads (one active in the last 10 minutes, or one still working:
   * a long turn writes no activity stamp); with none, ask Codex itself, at most every codexPollMs.
   * Then broadcast if the summary changed. The broadcast runs even when nothing was refreshed: an
   * account switch changes the summary with no new record.
   */
  tick(): void {
    try {
      this.maybeProbeClaude();
      if (!this.refreshCodexThreads()) this.maybePollCodex();
    } finally {
      this.schedule();
    }
  }

  /**
   * Read a bounded set of Codex threads, from every working one and any active lately. The least
   * recently polled go first, so a 5th working thread, or a live one behind rows stuck at
   * `working`, gets its turn within a few ticks. Ties go to working, then newest activity. Each
   * read records only a figure newer than the held one, so the newest report wins whatever the
   * order. False when there is no candidate thread (or no refresher): then Codex is asked directly.
   */
  private refreshCodexThreads(): boolean {
    const refresh = this.d.refreshCodex;
    if (!refresh) return false;
    const since = new Date(this.now() - this.o.codexActiveMs).toISOString();
    const rows = this.d.db.prepare(
      `SELECT id, external_id FROM terminals
       WHERE type = 'codex' AND archived_at IS NULL AND external_id IS NOT NULL
         AND (status = 'working' OR last_activity_at >= ?)
       ORDER BY (status = 'working') DESC, last_activity_at DESC`,
    ).all(since) as { id: string; external_id: string }[];
    // Forget threads that are no longer candidates, so the map stays as small as the set.
    const ids = new Set(rows.map((r) => r.id));
    for (const id of this.polledAt.keys()) if (!ids.has(id)) this.polledAt.delete(id);
    if (!rows.length) return false;
    // A stable sort keeps the SQL order among equal poll times.
    const picked = rows
      .map((row, i) => ({ row, i, at: this.polledAt.get(row.id) ?? 0 })) // 0: never polled, goes first
      .sort((a, b) => (a.at - b.at) || (a.i - b.i))
      .slice(0, this.o.codexRefreshMax);
    const now = this.now();
    for (const { row } of picked) {
      this.polledAt.set(row.id, now);
      try { refresh(row.id, row.external_id); } catch (err) { console.warn('[usage-gauge] Codex refresh failed:', err); }
    }
    return true;
  }

  /** No Codex thread active lately: ask Codex itself (codex-poll.ts), at most every codexPollMs. */
  private maybePollCodex(): void {
    if (!this.d.pollCodex || this.codexPolling || this.now() - this.lastCodexPoll < this.o.codexPollMs) return;
    this.lastCodexPoll = this.now();
    this.codexPolling = true;
    void this.d.pollCodex().catch(() => false).finally(() => { this.codexPolling = false; });
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
   * Send only when the payload changed. Percents are already integers. `at`, `epoch` and `rev` are
   * left out: they move on every call. `asOf` moves on every turn, so it is compared at 5-minute
   * grain: enough for the client's 30-minute staleness dim. A forecast's `runsOutAt` is left out
   * too. It is projected from now, so it moves on every tick with no new figure, and far faster
   * than the clock on a slow pace: 2 points an hour with 78 left moves it 40 minutes a minute, so
   * no fixed grain holds it still. A real change still sends: a new figure moves `usedPercent` or
   * `asOf`, and the pace's basis or a flip of `lastsUntilReset` is in the key. Every send carries
   * the fresh `runsOutAt`.
   *
   * A client shows "used up" once a held `runsOutAt` is past. So once the clock passes the soonest
   * one sent, send again with no other change. With no new figure the projection only moves later,
   * and faster as the span grows, so an idle episode resends a few times, not every tick. A window
   * already at 100% is used up for real and never sets this.
   */
  private send(): void {
    let summary: UsageSummary;
    try { summary = this.summary(); } catch (err) { console.warn('[usage-gauge] summary failed:', err); return; }
    const { at: _at, epoch: _epoch, rev: _rev, ...stable } = summary;
    const grain = (t: number) => Math.floor(t / (5 * MIN));
    const window = (w: SummaryWindow) => {
      if (!w.forecast) return w;
      const { runsOutAt: _runsOutAt, ...forecast } = w.forecast;
      return { ...w, forecast };
    };
    const providers = summary.providers.map((p) => ({
      ...p,
      asOf: grain(p.asOf),
      windows: Object.fromEntries(Object.entries(p.windows).map(([k, w]) => [k, window(w)])),
    }));
    const key = JSON.stringify({ ...stable, providers });
    const now = summary.at;
    if (key === this.lastSent && (this.resendAt === null || now < this.resendAt)) return;
    this.lastSent = key;
    this.resendAt = null;
    for (const p of summary.providers) {
      for (const w of Object.values(p.windows)) {
        const f = w.forecast;
        if (!f || f.lastsUntilReset || f.runsOutAt === null || f.runsOutAt <= now || (w.usedPercent ?? 0) >= 100) continue;
        if (this.resendAt === null || f.runsOutAt < this.resendAt) this.resendAt = f.runsOutAt;
      }
    }
    this.d.broadcast(summary as unknown as Record<string, unknown>);
  }
}
