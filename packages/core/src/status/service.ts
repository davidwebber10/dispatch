import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import * as sessionsDb from '../db/sessions.js';
import type { EventBroadcaster } from '../ws/events.js';
import { normalizeClaude, normalizeCodex, type ThreadStatus } from './events.js';
import { aggregateSessionStatus } from './aggregate.js';

// Normalized thread status -> the persisted terminal-status enum.
const TO_TERMINAL: Record<ThreadStatus, string> = {
  starting: 'working',
  working: 'working',
  needs_input: 'needs_input',
  idle: 'waiting',
  done: 'waiting',
  error: 'error',
};

/**
 * Ingests provider lifecycle events (Claude hooks, Codex notify), normalizes them
 * to one status model, persists the terminal/session status, captures the provider
 * session id on the first event that carries one (fixes unlinked threads), and
 * broadcasts `terminal:status` (with the rich threadStatus + activity) + session status.
 */
export class StatusService {
  private threadSettledHook: ((info: { terminalId: string; sessionId: string; threadStatus: ThreadStatus }) => void) | null = null;

  constructor(private db: Database.Database, private broadcaster: EventBroadcaster) {}

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

  private apply(sessionId: string, terminalId: string, status: ThreadStatus, activity?: string): void {
    const prior = terminalsDb.getById(this.db, terminalId)?.status; // persisted enum before update
    const terminalStatus = TO_TERMINAL[status];
    try { terminalsDb.updateStatus(this.db, terminalId, terminalStatus); } catch { /* best effort */ }
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
