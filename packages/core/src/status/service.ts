import type { HarnessEvent } from '../runtime/events.js';
import { recordHarnessUsage } from '../analytics/recorder.js';
import { logLifecycle, recordCaptureFailure } from '../runtime/diagnostics.js';
import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import * as sessionsDb from '../db/sessions.js';
import type { EventBroadcaster } from '../ws/events.js';
import type { ThreadStatus } from './events.js';
import { providerForHook } from '../providers/registry.js';
import { aggregateSessionStatus } from './aggregate.js';
import { resolveTranscriptPath } from '../sessions/transcript-path.js';

// Normalized thread status -> the persisted terminal-status enum. `terminals.status` is a
// free-form TEXT column (no CHECK constraint) — 'scheduled' rides the same convention as
// 'queued' (see sessions/service.ts createQueuedTerminal): a value TerminalStatus doesn't
// narrowly type, but the column happily stores and round-trips.
const TO_TERMINAL: Record<ThreadStatus, string> = {
  queued: 'queued',
  starting: 'waiting', // launching an interactive CLI does not start a turn
  working: 'working',
  needs_input: 'needs_input',
  idle: 'waiting',
  done: 'waiting',
  error: 'error',
  scheduled: 'scheduled',
};

export type TurnBoundary = { terminalId: string; sessionId: string; threadStatus: ThreadStatus; phase: 'baseline' | 'start' | 'end'; nativeTurnId?: string };
export type TurnBoundaryListener = (event: TurnBoundary) => void;

export type SettledListener = (info: { terminalId: string; sessionId: string; threadStatus: ThreadStatus }) => void;

/**
 * Ingests provider lifecycle events (Claude hooks, Codex notify), normalizes them
 * to one status model, persists the terminal/session status, captures the provider
 * session id on the first event that carries one (fixes unlinked threads), and
 * broadcasts `terminal:status` (with the rich threadStatus + activity) + session status.
 */
export class StatusService {
  diagnostics(terminalId: string) {
    return {
      lifecycle: this.db.prepare('SELECT * FROM thread_lifecycle WHERE terminal_id=?').get(terminalId) ?? null,
      captureFailure: this.db.prepare('SELECT * FROM capture_failures WHERE terminal_id=?').get(terminalId) ?? null,
      events: this.db.prepare('SELECT event_type,generation,turn_id,observed_at,status,disposition FROM lifecycle_events WHERE terminal_id=? ORDER BY id DESC LIMIT 200').all(terminalId),
    };
  }

  markInferred(terminalId: string, status: 'working' | 'waiting'): void {
    this.transition(() => {
      const terminal = terminalsDb.getById(this.db, terminalId);
      if (!terminal || this.db.prepare("SELECT 1 FROM thread_lifecycle WHERE terminal_id=? AND source='authoritative'").get(terminalId)) return;
      terminalsDb.updateStatus(this.db, terminalId, status);
      this.db.prepare(`INSERT INTO thread_lifecycle(terminal_id,status,source,observed_at) VALUES (?,?,'inferred',?)
        ON CONFLICT(terminal_id) DO UPDATE SET status=excluded.status,source='inferred',observed_at=excluded.observed_at`).run(terminalId,status,new Date().toISOString());
      logLifecycle(this.db,{ terminalId,type: `status.${status}`,observedAt: new Date().toISOString() },'inferred');
      this.defer(() => this.broadcaster.broadcast({ type: 'terminal:status', terminalId, status }));
      this.aggregateSession(terminal.session_id);
    });
  }

  setTerminalState(terminalId: string, status: 'queued' | 'waiting' | 'error'): void {
    this.transition(() => {
      const terminal = terminalsDb.getById(this.db, terminalId);
      if (terminal) this.apply(terminal.session_id, terminalId, status === 'waiting' ? 'idle' : status);
    });
  }

  private committedListeners: ((event: HarnessEvent) => void)[] = [];
  onHarnessCommitted(listener: (event: HarnessEvent) => void): void { this.committedListeners.push(listener); }

  private effects: (() => void)[] | null = null;
  private pendingEffects: (() => void)[] = [];
  private flushingEffects = false;
  private currentEvent: HarnessEvent | null = null;
  private flushEffects(): void {
    if (this.flushingEffects) return;
    this.flushingEffects = true;
    try {
      while (this.pendingEffects.length) {
        try { this.pendingEffects.shift()!(); }
        catch (error) { console.warn('Lifecycle effect failed:', error instanceof Error ? error.message : String(error)); }
      }
    } finally { this.flushingEffects = false; }
  }
  private defer(fn: () => void): void {
    if (this.effects) this.effects.push(fn);
    else { this.pendingEffects.push(fn); this.flushEffects(); }
  }
  private transition(fn: () => void): void {
    if (this.effects) { fn(); return; }
    const effects: (() => void)[] = [];
    this.effects = effects;
    try { this.db.transaction(fn)(); }
    finally { this.effects = null; }
    this.pendingEffects.push(...effects);
    this.flushEffects();
  }

  /** One owner commits usage, lifecycle state, and diagnostics before any effects. */
  accept(event: HarnessEvent, afterCommit?: (event: HarnessEvent) => void): boolean {
    if (this.flushingEffects) {
      this.pendingEffects.push(() => this.acceptEvent(event, afterCommit));
      return true; // queued behind all effects of the preceding transition
    }
    return this.acceptEvent(event, afterCommit);
  }

  private acceptEvent(event: HarnessEvent, afterCommit?: (event: HarnessEvent) => void): boolean {
    if (!this.db.open) return false;
    let accepted = false;
    try {
      this.transition(() => {
        const terminal = terminalsDb.getById(this.db, event.terminalId);
        if (!terminal || terminal.type !== event.provider) return;
        const previous = this.db.prepare('SELECT generation,sequence,turn_id,turn_open FROM thread_lifecycle WHERE terminal_id=?').get(event.terminalId) as
          { generation: string | null; sequence: number; turn_id: string | null; turn_open: number } | undefined;
        let rejection: string | undefined;
        if (event.type === 'process.started' && previous?.generation !== event.generation && this.db.prepare('SELECT 1 FROM harness_generations WHERE terminal_id=? AND generation=?').get(event.terminalId,event.generation)) rejection = 'retired-generation';
        else if (event.type !== 'process.started' && previous?.generation && previous.generation !== event.generation) rejection = 'stale-generation';
        else if (previous?.generation === event.generation && event.sequence <= previous.sequence) rejection = 'duplicate-or-out-of-order';
        else if (event.turnId && previous?.turn_id && event.type !== 'turn.started' && event.type !== 'process.started' && event.turnId !== previous.turn_id) rejection = 'stale-turn';
        else if (['turn.completed','turn.failed','permission.requested','permission.resolved'].includes(event.type) && !previous?.turn_open) rejection = 'turn-already-closed';
        if (event.type === 'usage.observed' && event.turnId && !previous?.turn_open && !event.measurements.every(m => m.counter?.baselineOnly)) rejection ??= 'turn-already-closed';
        if (rejection) { logLifecycle(this.db, event, rejection); return; }
        if (event.type === 'process.started' && previous?.generation && previous.generation !== event.generation) {
          this.db.prepare("UPDATE usage_turns SET ended_at=started_at,outcome='interrupted',duration_ms=NULL,coverage='partial' WHERE terminal_id=? AND ended_at IS NULL").run(event.terminalId);
        }
        if (event.type === 'process.started') this.db.prepare('INSERT OR IGNORE INTO harness_generations VALUES (?,?,?)').run(event.terminalId,event.generation,event.observedAt);
        this.currentEvent = event;
        const closed = recordHarnessUsage(this.db, event);
        switch (event.type) {
          case 'capture.failed': recordCaptureFailure(this.db,event.terminalId,event.type,new Error(event.reason)); break;
          case 'turn.started': this.markWorking(event.terminalId, 'Working…'); break;
          case 'permission.requested': this.markNeedsInput(event.terminalId, event.questions?.length ? 'Needs your answer' : `Needs approval: ${event.toolName ?? 'tool'}`); break;
          case 'permission.resolved': this.markWorking(event.terminalId, 'Working…'); break;
          case 'turn.completed':
            if (event.outcome === 'needs_help') this.markNeedsInput(event.terminalId, event.detail.ask ?? 'Asked a question');
            else if (event.outcome === 'scheduled') this.markScheduled(event.terminalId, event.detail.activity);
            else this.markIdle(event.terminalId);
            break;
          case 'turn.failed': this.markFailed(event.terminalId); break;
          case 'process.exited': this.markExited(event.terminalId, event.exitCode); break;
        }
        const open = event.type === 'turn.started' ? 1 : ['process.started','turn.completed','turn.failed','process.exited'].includes(event.type) ? 0 : previous?.turn_open ?? 0;
        this.db.prepare(`INSERT INTO thread_lifecycle(terminal_id,status,source,observed_at,generation,sequence,turn_id,turn_open)
          VALUES (?,?, 'authoritative',?,?,?,?,?) ON CONFLICT(terminal_id) DO UPDATE SET generation=excluded.generation,
          sequence=excluded.sequence,turn_id=excluded.turn_id,turn_open=excluded.turn_open`)
          .run(event.terminalId,terminalsDb.getById(this.db,event.terminalId)!.status ?? 'waiting',event.observedAt,event.generation,event.sequence,event.turnId ?? previous?.turn_id ?? null,open);
        logLifecycle(this.db, event, 'applied');
        if (closed) this.defer(() => this.broadcaster.broadcast({ type: 'analytics-dirty' }));
        if (afterCommit) this.defer(() => afterCommit(event));
        for (const listener of this.committedListeners) this.defer(() => listener(event));
        accepted = true;
      });
    } catch (error) {
      recordCaptureFailure(this.db,event.terminalId,event.type,error);
      console.warn('Harness event capture failed:', event.type, error instanceof Error ? error.message : String(error));
      accepted = false;
    } finally { this.currentEvent = null; }
    return accepted;
  }

  private turnListeners: TurnBoundaryListener[] = [];
  addTurnBoundaryListener(listener: TurnBoundaryListener): void { this.turnListeners.push(listener); }

  private turnBoundary(event: TurnBoundary): void {
    for (const listener of this.turnListeners) listener(event);
  }

  private settledListeners: SettledListener[] = [];

  constructor(
    private db: Database.Database,
    private broadcaster: EventBroadcaster,
    /** Optional real-activity signal (feeds ThreadAutoNamer.notifyActivity). Fires on the same edge as touchActivity, below. */
    private onActivity?: (terminalId: string) => void,
    /** Optional watch-wake signal (feeds WatchDispatcher.onStatus). Fires on the same edge as onActivity, above. */
    private onWatchStatus?: (terminalId: string, status: ThreadStatus) => void,
    private onUserPrompt?: (terminalId: string, prompt: string) => void,
  ) {}

  /**
   * Subscribe to the turn-settled edge. A LIST, not a single hook: push notifications
   * and analytics capture both consume this, and a setter would have let whichever
   * wired second silently disable the first.
   */
  addThreadSettledListener(fn: SettledListener): void {
    this.settledListeners.push(fn);
  }

  ingest(provider: string, terminalId: string, payload: unknown): void {
    if (!this.db.open) return;
    try { this.transition(() => this.ingestInternal(provider, terminalId, payload)); }
    catch (error) { recordCaptureFailure(this.db,terminalId,'hook',error); throw error; }
  }

  private ingestInternal(provider: string, terminalId: string, payload: unknown): void {
    const harness = providerForHook(provider);
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!harness || !terminal || terminal.type !== harness.name) return;
    const norm = harness.telemetry.normalizeHook(payload);
    if (norm.turn === 'start' && typeof (payload as any)?.prompt === 'string') this.onUserPrompt?.(terminalId, (payload as any).prompt);

    // Capture the session/thread id at the source — no more filesystem polling. First-write
    // for a healthy identity; a stored id with NO transcript anywhere (a ghost from a boot
    // that never ran a turn) is healed to the live process's self-reported id — see the
    // structured twin in sessions/service.ts setStructuredManager.
    if (norm.sessionId && terminal.external_id !== norm.sessionId) {
      let healthy = !!terminal.external_id && terminal.type !== 'claude-code';
      if (terminal.external_id && terminal.type === 'claude-code') {
        const session = sessionsDb.getById(this.db, terminal.session_id);
        const workDir = terminal.working_dir || session?.working_dir || '';
        healthy = !!resolveTranscriptPath(workDir, terminal.external_id);
      }
      if (!healthy) {
        try { terminalsDb.updateExternalId(this.db, terminalId, norm.sessionId); } catch { /* best effort */ }
      }
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
    if (norm.turn === 'end' && norm.status === 'idle') {
      const settled = this.consumePendingDeclaration(terminal, terminalId);
      if (settled) { status = settled.status; activity = settled.activity; }
    }

    if (norm.turn) this.turnBoundary({ terminalId, sessionId: terminal.session_id, threadStatus: status, phase: norm.turn, nativeTurnId: norm.turnId });
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
    if (!this.db.open) return;
    this.transition(() => this.markWorkingInternal(terminalId, activity));
  }

  private markWorkingInternal(terminalId: string, activity?: string): void {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (terminal) {
      this.turnBoundary({ terminalId, sessionId: terminal.session_id, threadStatus: 'working', phase: 'start' });
      this.apply(terminal.session_id, terminalId, 'working', activity);
    }
  }

  /**
   * Escalation edge: a structured AGENT thread hit a gated tool / AskUserQuestion
   * and is blocked awaiting a human decision (the membrane). Surfaces as needs_input.
   */
  markNeedsInput(terminalId: string, activity?: string): void {
    if (!this.db.open) return;
    this.transition(() => this.markNeedsInputInternal(terminalId, activity));
  }

  private markNeedsInputInternal(terminalId: string, activity?: string): void {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (terminal) this.apply(terminal.session_id, terminalId, 'needs_input', activity);
  }

  /**
   * Settle edge: a structured thread's turn completed (the `result` event). Flips it off
   * `working` so the rail + list_agents reflect reality (fixes the stale-working bug) and
   * fires the settled hook (push / coordinator completion notice).
   */
  markIdle(terminalId: string, activity?: string): void {
    if (!this.db.open) return;
    this.transition(() => this.markIdleInternal(terminalId, activity));
  }

  private markIdleInternal(terminalId: string, activity?: string): void {
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
    if (!this.db.open) return;
    this.transition(() => this.markScheduledInternal(terminalId, activity));
  }

  private markScheduledInternal(terminalId: string, activity?: string): void {
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

  /** After boot recovery, persisted working state must have a live owner. */
  reconcileProcesses(isAlive: (terminalId: string) => boolean): void {
    if (!this.db.open) return;
    const rows = this.db.prepare("SELECT id FROM terminals WHERE archived_at IS NULL AND status IN ('working','needs_input')").all() as { id: string }[];
    for (const { id } of rows) if (!isAlive(id)) this.markExited(id, 1);
  }

  markFailed(terminalId: string): void {
    if (!this.db.open) return;
    this.transition(() => this.markFailedInternal(terminalId));
  }

  private markFailedInternal(terminalId: string): void {
    if (!this.db.open) return;
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (terminal) this.apply(terminal.session_id, terminalId, 'error');
  }

  /** All structured harnesses share process-exit reconciliation. */
  markExited(terminalId: string, exitCode: number): void {
    if (!this.db.open) return;
    this.transition(() => this.markExitedInternal(terminalId, exitCode));
  }

  private markExitedInternal(terminalId: string, exitCode: number): void {
    if (!this.db.open) return;
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return;
    this.turnBoundary({ terminalId, sessionId: terminal.session_id, threadStatus: exitCode === 0 ? 'done' : 'error', phase: 'end' });
    terminalsDb.updatePid(this.db, terminalId, null);
    this.apply(terminal.session_id, terminalId, exitCode === 0 ? 'done' : 'error');
    this.defer(() => this.broadcaster.broadcast({ type: 'terminal:exit', terminalId, sessionId: terminal.session_id }));
  }

  private apply(sessionId: string, terminalId: string, status: ThreadStatus, activity?: string): void {
    this.db.prepare(`INSERT INTO thread_lifecycle(terminal_id, external_session_id, status, source, observed_at) VALUES (?, ?, ?, 'authoritative', ?)
      ON CONFLICT(terminal_id) DO UPDATE SET external_session_id=excluded.external_session_id, status=excluded.status, source=excluded.source, observed_at=excluded.observed_at`)
      .run(terminalId, terminalsDb.getById(this.db, terminalId)?.external_id ?? '', status, new Date().toISOString());
    const prior = terminalsDb.getById(this.db, terminalId)?.status; // persisted enum before update
    const terminalStatus = TO_TERMINAL[status];
    terminalsDb.updateStatus(this.db, terminalId, terminalStatus);
    if (!this.currentEvent) logLifecycle(this.db, { terminalId, type: `status.${status}`, observedAt: new Date().toISOString() }, 'applied');
    // Activity means "the thread thought about something": a turn started/ended, it
    // asked for input, went dormant, or errored. 'starting' (SessionStart) is an
    // open/revive edge — attaching to a thread must not make it look recently active.
    if (status !== 'starting') {
      terminalsDb.touchActivity(this.db, terminalId);
      sessionsDb.touchActivity(this.db, sessionId);
      this.defer(() => this.onActivity?.(terminalId));
      this.defer(() => this.onWatchStatus?.(terminalId, status));
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
    this.defer(() => this.broadcaster.broadcast({ type: 'terminal:status', terminalId, status: terminalStatus, threadStatus: status, activity: activity ?? null }));
    if (status !== 'starting' && prior === 'working' && (terminalStatus === 'waiting' || terminalStatus === 'needs_input')) {
      for (const fn of this.settledListeners) {
        this.defer(() => fn({ terminalId, sessionId, threadStatus: status }));
      }
    }
    this.aggregateSession(sessionId);
  }

  private aggregateSession(sessionId: string): void {
    const status = aggregateSessionStatus(terminalsDb.listBySession(this.db, sessionId).map((t) => t.status || 'waiting'));
    sessionsDb.updateStatus(this.db, sessionId, status);
    // Carry the freshly-bumped activity stamp (apply() calls touchActivity before this) so the
    // project card's timestamp + "most recent" sort update live, not just on a full reload.
    const lastActivityAt = sessionsDb.getLastActivity(this.db, sessionId);
    this.defer(() => this.broadcaster.broadcast({ type: 'session:status', sessionId, status, lastActivityAt }));
  }
}
