import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import * as sessionsDb from '../db/sessions.js';
import type { EventBroadcaster } from '../ws/events.js';
import { normalizeClaude, normalizeCodex, type ThreadStatus } from './events.js';
import { aggregateSessionStatus } from './aggregate.js';

// Normalized thread status -> the persisted terminal-status enum. `terminals.status` is a
// free-form TEXT column (no CHECK constraint) — 'scheduled' rides the same convention as
// 'queued' (see sessions/service.ts createQueuedTerminal): a value TerminalStatus doesn't
// narrowly type, but the column happily stores and round-trips.
const TO_TERMINAL: Record<ThreadStatus, string> = {
  starting: 'working',
  working: 'working',
  needs_input: 'needs_input',
  idle: 'waiting',
  done: 'waiting',
  error: 'error',
  scheduled: 'scheduled',
};

/**
 * Ingests provider lifecycle events (Claude hooks, Codex notify), normalizes them
 * to one status model, persists the terminal/session status, captures the provider
 * session id on the first event that carries one (fixes unlinked threads), and
 * broadcasts `terminal:status` (with the rich threadStatus + activity) + session status.
 */
export class StatusService {
  private threadSettledHook: ((info: { terminalId: string; sessionId: string; threadStatus: ThreadStatus }) => void) | null = null;

  constructor(
    private db: Database.Database,
    private broadcaster: EventBroadcaster,
    /** Optional real-activity signal (feeds ThreadAutoNamer.notifyActivity). Fires on the same edge as touchActivity, below. */
    private onActivity?: (terminalId: string) => void,
  ) {}

  setThreadSettledHook(fn: (info: { terminalId: string; sessionId: string; threadStatus: ThreadStatus }) => void): void {
    this.threadSettledHook = fn;
  }

  ingest(provider: string, terminalId: string, payload: unknown): void {
    const norm = provider === 'codex' ? normalizeCodex(payload) : normalizeClaude(payload);
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return;

    // Capture the session/thread id at the source — no more filesystem polling.
    if (norm.sessionId && !terminal.external_id) {
      try { terminalsDb.updateExternalId(this.db, terminalId, norm.sessionId); } catch { /* best effort */ }
    }

    if (!norm.status) return; // id-only event (no status change)
    this.apply(terminal.session_id, terminalId, norm.status, norm.activity);
  }

  /** Input edge: when the user sends a message the thread is working. */
  markWorking(terminalId: string, activity?: string): void {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (terminal) this.apply(terminal.session_id, terminalId, 'working', activity);
  }

  /**
   * Escalation edge: a structured AGENT thread hit a gated tool / AskUserQuestion
   * and is blocked awaiting a human decision (the membrane). Surfaces as needs_input.
   */
  markNeedsInput(terminalId: string, activity?: string): void {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (terminal) this.apply(terminal.session_id, terminalId, 'needs_input', activity);
  }

  /**
   * Settle edge: a structured thread's turn completed (the `result` event). Flips it off
   * `working` so the rail + list_agents reflect reality (fixes the stale-working bug) and
   * fires the settled hook (push / coordinator completion notice).
   */
  markIdle(terminalId: string, activity?: string): void {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (terminal) this.apply(terminal.session_id, terminalId, 'idle', activity);
  }

  /**
   * Dormant edge: a structured thread ended its turn by calling a wake-scheduler tool
   * (ScheduleWakeup/CronCreate) — it will resume on its own, so it must NOT be treated as
   * idle/done (no completion notice to a coordinator, no "finished" push). Distinct from
   * markIdle purely so callers (wirePermissionMembrane) can't accidentally wire it to
   * noteAgentCompletion the way the 'idle' listener does.
   */
  markScheduled(terminalId: string, activity?: string): void {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return;
    this.apply(terminal.session_id, terminalId, 'scheduled', activity);
    // Best-effort: stamp when it went dormant for a future "resumes when…" tooltip. The
    // terminal row is already in hand (no extra read); updateConfig replaces the whole
    // blob, so merge onto the existing parsed config rather than clobbering it.
    try {
      const config = JSON.parse(terminal.config || '{}');
      terminalsDb.updateConfig(this.db, terminalId, { ...config, scheduledWake: activity ?? 'Scheduled — will resume automatically' });
    } catch { /* best effort */ }
  }

  private apply(sessionId: string, terminalId: string, status: ThreadStatus, activity?: string): void {
    const prior = terminalsDb.getById(this.db, terminalId)?.status; // persisted enum before update
    const terminalStatus = TO_TERMINAL[status];
    try { terminalsDb.updateStatus(this.db, terminalId, terminalStatus); } catch { /* best effort */ }
    // Activity means "the thread thought about something": a turn started/ended, it
    // asked for input, went dormant, or errored. 'starting' (SessionStart) is an
    // open/revive edge — attaching to a thread must not make it look recently active.
    if (status !== 'starting') {
      try { terminalsDb.touchActivity(this.db, terminalId); } catch { /* best effort */ }
      try { sessionsDb.touchActivity(this.db, sessionId); } catch { /* best effort */ }
      try { this.onActivity?.(terminalId); } catch { /* best effort */ }
    }
    this.broadcaster.broadcast({ type: 'terminal:status', terminalId, status: terminalStatus, threadStatus: status, activity: activity ?? null });
    if (prior === 'working' && (terminalStatus === 'waiting' || terminalStatus === 'needs_input')) {
      try { this.threadSettledHook?.({ terminalId, sessionId, threadStatus: status }); } catch { /* hook must never break status */ }
    }
    this.aggregateSession(sessionId);
  }

  private aggregateSession(sessionId: string): void {
    const status = aggregateSessionStatus(terminalsDb.listBySession(this.db, sessionId).map((t) => t.status || 'waiting'));
    try { sessionsDb.updateStatus(this.db, sessionId, status); } catch { /* best effort */ }
    this.broadcaster.broadcast({ type: 'session:status', sessionId, status });
  }
}
