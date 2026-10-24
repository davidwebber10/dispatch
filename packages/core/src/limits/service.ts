// packages/core/src/limits/service.ts
// Parks a thread that stopped on an agent CLI usage limit and wakes it after the reset.
import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import * as parksDb from '../db/usage-limits.js';
import { pauseLabel, type UsageLimit } from './detect.js';

/** The message a parked thread gets when its limit has reset. */
export const RESUME_TEXT = 'Your usage limit has reset. Continue where you left off.';

const MIN = 60_000;
const DEFAULTS = {
  /** Extra wait after the reset, so the first request is not early. */
  bufferMs: 90_000,
  /** Gap between two wakes of one provider (many threads hit the limit together). */
  staggerMs: 20_000,
  /** Wakes with no finished turn in between before giving up. */
  maxAttempts: 5,
  /** Retry delay when the CLI gave no readable reset time. */
  fallbackSessionMs: 30 * MIN,
  fallbackWeeklyMs: 6 * 60 * MIN,
  /** Retry delay after a wake that could not be sent. */
  sendRetryMs: 5 * MIN,
  tickMs: 30_000,
};

export interface UsageLimitDeps {
  db: Database.Database;
  /** Show the thread as paused (the dormant state, with this label). */
  markPaused(terminalId: string, label: string): void;
  /** Send the resume message. Throws when it cannot be delivered. */
  wake(terminalId: string, text: string): void;
  /** One line for Chat. `deliver` also wakes Chat to read it. */
  note(terminalId: string, text: string, opts: { deliver: boolean }): void;
  now?: () => number;
  /** The zone the pause label is shown in. Default: this machine. */
  zone?: string;
  options?: Partial<typeof DEFAULTS>;
}

export class UsageLimitService {
  private readonly o: typeof DEFAULTS;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private lastWake = new Map<string, number>();

  constructor(private readonly d: UsageLimitDeps) {
    this.o = { ...DEFAULTS, ...d.options };
    this.now = d.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.tick(); } catch (err) { console.warn('[usage-limit] tick failed:', err); } }, this.o.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private threadName(terminalId: string): string {
    return terminalsDb.getById(this.d.db, terminalId)?.label || terminalId;
  }

  /** The thread stopped on a usage limit. Stores it, labels it, and (first stop of a chain) tells Chat. */
  park(terminalId: string, provider: string, limit: UsageLimit): void {
    const now = this.now();
    const prior = parksDb.get(this.d.db, terminalId);
    const attempts = prior?.attempts ?? 0;
    const parsed = limit.resetsAt !== null;
    const fallbackMs = limit.kind === 'weekly' ? this.o.fallbackWeeklyMs : this.o.fallbackSessionMs;
    const wakeAt = parsed ? Math.max(limit.resetsAt!, now) + this.o.bufferMs : now + fallbackMs;
    const capped = attempts >= this.o.maxAttempts;
    parksDb.upsert(this.d.db, {
      terminal_id: terminalId, provider, kind: limit.kind, resets_at: limit.resetsAt, wake_at: wakeAt,
      message: limit.message.slice(0, 1000), parsed: parsed ? 1 : 0, attempts,
      state: capped ? 'capped' : 'parked', parked_at: prior?.parked_at ?? now,
    }, now);
    const label = pauseLabel(limit.kind, limit.resetsAt, now, this.d.zone, fallbackMs);
    if (capped) {
      this.d.note(terminalId, `[${this.threadName(terminalId)}] still hits the ${limit.kind} limit after ${attempts} automatic resumes. It stays stopped. Send it a message to continue.`, { deliver: true });
      return;
    }
    this.safe(() => this.d.markPaused(terminalId, label));
    if (!prior) {
      const tail = parsed ? ' It resumes by itself.' : ` The reset time could not be read, so it retries in ${fallbackMs / MIN >= 120 ? `${fallbackMs / MIN / 60} hours` : `${fallbackMs / MIN} minutes`}.`;
      this.d.note(terminalId, `[${this.threadName(terminalId)}] ${label}.${tail}`, { deliver: false });
    }
  }

  /** Wake every parked thread whose time has come, at most one per provider per stagger gap. */
  tick(): void {
    const now = this.now();
    for (const row of parksDb.listDue(this.d.db, now)) {
      const t = terminalsDb.getById(this.d.db, row.terminal_id);
      if (!t || t.archived_at || t.status === 'working') { parksDb.remove(this.d.db, row.terminal_id); continue; }
      const last = this.lastWake.get(row.provider);
      if (last !== undefined && now - last < this.o.staggerMs) continue;
      this.lastWake.set(row.provider, now);
      const attempts = row.attempts + 1;
      try {
        this.d.wake(row.terminal_id, RESUME_TEXT);
        parksDb.setState(this.d.db, row.terminal_id, 'woken', attempts, row.wake_at, now);
        this.d.note(row.terminal_id, `[${t.label || row.terminal_id}] resumed after the ${row.kind} limit (attempt ${attempts} of ${this.o.maxAttempts}).`, { deliver: false });
      } catch (err) {
        console.warn(`[usage-limit] could not wake ${row.terminal_id}:`, err instanceof Error ? err.message : err);
        if (attempts >= this.o.maxAttempts) {
          parksDb.setState(this.d.db, row.terminal_id, 'capped', attempts, row.wake_at, now);
          this.d.note(row.terminal_id, `[${t.label || row.terminal_id}] could not be resumed after ${attempts} tries. It stays stopped. Send it a message to continue.`, { deliver: true });
        } else {
          parksDb.setState(this.d.db, row.terminal_id, 'parked', attempts, now + this.o.sendRetryMs, now);
        }
      }
    }
  }

  /** The owner sent the thread a message or typed in it: they took over, so no auto-resume. */
  onUserMessage(terminalId: string): void { parksDb.remove(this.d.db, terminalId); }
  /** The thread was stopped, archived or deleted. */
  onStopped(terminalId: string): void { parksDb.remove(this.d.db, terminalId); }
  /** A turn finished normally: a resumed thread is done with its pause. */
  onTurnSettled(terminalId: string): void {
    const row = parksDb.get(this.d.db, terminalId);
    if (row && row.state === 'woken') parksDb.remove(this.d.db, terminalId);
  }

  /** At boot: the status of every thread was reset, so show the parked ones as paused again. */
  restore(): void {
    const now = this.now();
    for (const row of parksDb.listActive(this.d.db)) {
      const t = terminalsDb.getById(this.d.db, row.terminal_id);
      if (!t || t.archived_at) { parksDb.remove(this.d.db, row.terminal_id); continue; }
      const fallback = row.kind === 'weekly' ? this.o.fallbackWeeklyMs : this.o.fallbackSessionMs;
      this.safe(() => this.d.markPaused(row.terminal_id, pauseLabel(row.kind, row.resets_at, now, this.d.zone, fallback)));
    }
  }

  private safe(fn: () => void): void {
    try { fn(); } catch (err) { console.warn('[usage-limit] a callback failed:', err); }
  }
}
