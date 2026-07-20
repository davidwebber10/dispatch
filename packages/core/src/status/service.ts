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
    /** Optional watch-wake signal (feeds WatchDispatcher.onStatus). Fires on the same edge as onActivity, above. */
    private onWatchStatus?: (terminalId: string, status: ThreadStatus) => void,
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

    // PTY/CLI turn boundary: the `Stop` hook is a separate request from wherever a
    // report_status declaration was written (SessionService.reportStatus's fallback, since
    // a PTY thread has no live structured session for that route to store it on
    // in-memory — see that method's doc comment). So THIS is where it must be consulted
    // and cleared, mirroring how the structured path reads+clears `session.declared` at its
    // `result` boundary. normalizeClaude stays pure (no DB access) — the read/clear lives
    // here, in its caller, which already holds the db handle.
    let status = norm.status;
    let activity = norm.activity;
    if ((payload as { hook_event_name?: unknown } | null)?.hook_event_name === 'Stop') {
      const settled = this.consumePendingDeclaration(terminal, terminalId);
      if (settled) { status = settled.status; activity = settled.activity; }
    }

    this.apply(terminal.session_id, terminalId, status, activity);
  }

  /**
   * Reads terminal.config.pendingDeclaration (set by SessionService.reportStatus's PTY
   * fallback) and, if present: maps it to a status — `needs_you` wins (needs_input);
   * `done`/`blocked` both settle idle, parity with the structured `result` handler, which
   * explicitly falls `blocked` through to idle (a thread waiting on another agent still
   * proceeds without the human) — stamps `config.lastOutcome` the SAME shape
   * SessionService.noteTurnOutcome writes for the structured path (a declared PTY turn is
   * always `inferred: false`), including its two optional keys:
   *   declaredState?: 'done' | 'blocked' — set only when `decl.state` is 'done' or 'blocked';
   *                              absent for a 'needs_you' declaration (which settles
   *                              needs_input below and never reaches an idle outcome), matching
   *                              the structured path where a declared needs_you never reaches
   *                              this code either.
   *   blocker?: string         — the agent's own text for what it's waiting on, present only
   *                              alongside `declaredState === 'blocked'`, and only when
   *                              `decl.blocker` is non-empty after trimming (an empty or
   *                              whitespace-only string omits the key, never persists '').
   * and CLEARS the declaration so it cannot leak into the next turn. Returns null when
   * there's nothing pending (the common case for most Stop events).
   */
  private consumePendingDeclaration(terminal: terminalsDb.TerminalRow, terminalId: string): { status: ThreadStatus; activity?: string } | null {
    let cfg: Record<string, any> = {};
    try { cfg = JSON.parse(terminal.config || '{}'); } catch { /* default {} */ }
    const decl = cfg.pendingDeclaration;
    if (!decl || typeof decl !== 'object') return null;

    delete cfg.pendingDeclaration; // per-turn — must not leak into the next Stop
    const needsHelp = decl.state === 'needs_you';
    const declaredState = decl.state === 'done' || decl.state === 'blocked' ? decl.state : undefined;
    const blocker = declaredState === 'blocked' && typeof decl.blocker === 'string' && decl.blocker.trim() ? decl.blocker : undefined;
    cfg.lastOutcome = {
      summary: String(decl.summary ?? '').slice(0, 400),
      needsHelp,
      inferred: false,
      ...(declaredState ? { declaredState } : {}),
      ...(blocker ? { blocker } : {}),
      at: new Date().toISOString(),
    };
    try { terminalsDb.updateConfig(this.db, terminalId, cfg); } catch { /* best effort */ }

    if (needsHelp) {
      const ask = typeof decl.ask === 'string' && decl.ask ? decl.ask : decl.summary;
      return { status: 'needs_input', activity: typeof ask === 'string' ? ask.slice(0, 120) : undefined };
    }
    return { status: 'idle' };
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
      try { this.onWatchStatus?.(terminalId, status); } catch { /* best effort */ }
    }
    // A manual override is a correction to a stale derived status. `apply()` only ever runs
    // in response to a genuine status event, so EVERY call here is real activity — resumes,
    // escalations, settles, errors, all of it — and clears the override. Deliberately not a
    // status whitelist: enumerating "which statuses count as activity" is exactly what let a
    // thread that settled normally (idle) keep a stale override forever. Nothing on this
    // board should be able to permanently silence itself.
    try {
      const cfg = JSON.parse(terminalsDb.getById(this.db, terminalId)?.config || '{}');
      if (cfg.boardState?.override) {
        cfg.boardState = { ...cfg.boardState, override: null };
        terminalsDb.updateConfig(this.db, terminalId, cfg);
      }
    } catch { /* best effort — status must never fail on board bookkeeping */ }
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
