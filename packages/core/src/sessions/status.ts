import type Database from 'better-sqlite3';
import type { SessionStatus } from '../types.js';
import type { PTYManager } from '../pty/manager.js';
import type { EventBroadcaster } from '../ws/events.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { getProvider } from '../providers/registry.js';

// A thread is "working" while its PTY is still emitting output. Claude Code /
// Codex animate a spinner continuously while a turn is active (including during
// tool calls), so recent output is a reliable "running" signal; a few seconds of
// silence means it's back at the prompt.
const ACTIVITY_THRESHOLD_MS = 4_000;
const DEFAULT_INTERVAL_MS = 2_000;

export function mapHookEventToStatus(eventName: string): SessionStatus | null {
  switch (eventName) {
    case 'UserPromptSubmit':
      return 'working';
    case 'Stop':
      return 'waiting';
    case 'Notification':
      return 'needs_input';
    default:
      return null;
  }
}

/**
 * Drives live thread (terminal) status from PTY activity. Modern PTYs are keyed
 * by terminal id, so we walk the live PTYs directly rather than the sessions
 * table (whose ids don't match the PTY map). Each interactive terminal is marked
 * `working` while its PTY is active and `waiting` once it goes quiet; a
 * hook-set `needs_input` is kept sticky until output resumes. Session status is
 * then rolled up from its terminals. Returns the interval id for cleanup.
 */
export function startPtyTimingLoop(
  db: Database.Database,
  ptyManager: PTYManager,
  broadcaster: EventBroadcaster,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): NodeJS.Timeout {
  return setInterval(() => ptyStatusTick(db, ptyManager, broadcaster), intervalMs);
}

/** One pass of the activity → status reconciliation (exported for tests). */
export function ptyStatusTick(
  db: Database.Database,
  ptyManager: PTYManager,
  broadcaster: EventBroadcaster,
): void {
  {
    const now = Date.now();
    const touchedSessions = new Set<string>();

    for (const id of ptyManager.liveIds()) {
      const term = terminalsDb.getById(db, id);
      if (!term) continue;                         // legacy session-keyed PTY — skip
      if (!terminalsDb.isPtyType(term.type)) continue;
      // Hook-driven providers (Claude Code) get authoritative status from the
      // StatusService; PTY-output timing only drives pty-timing providers (Codex).
      let provider; try { provider = getProvider(term.type); } catch { provider = null; }
      if (provider?.statusStrategy === 'hooks') continue;
      let config: { runner?: boolean } = {};
      try { config = JSON.parse(term.config || '{}'); } catch { /* default {} */ }
      if (config.runner) continue;                 // agent-run terminals are owned by AgentService

      const last = ptyManager.getLastActivity(id);
      const recent = !!last && now - last.getTime() <= ACTIVITY_THRESHOLD_MS;
      const current = term.status || 'waiting';
      const next: SessionStatus = recent
        ? 'working'
        : current === 'needs_input' ? 'needs_input' : 'waiting';

      if (next !== current) {
        terminalsDb.updateStatus(db, id, next);
        broadcaster.broadcast({ type: 'terminal:status', terminalId: id, status: next });
        touchedSessions.add(term.session_id);
      }
    }

    for (const sessionId of touchedSessions) {
      let sessionStatus: SessionStatus = 'waiting';
      for (const t of terminalsDb.listBySession(db, sessionId)) {
        const s = t.status || 'waiting';
        if (s === 'working') { sessionStatus = 'working'; break; }
        if (s === 'needs_input') sessionStatus = 'needs_input';
      }
      const session = sessionsDb.getById(db, sessionId);
      if (session && session.status !== 'done' && session.status !== sessionStatus) {
        sessionsDb.updateStatus(db, sessionId, sessionStatus);
        broadcaster.broadcast({ type: 'session:status', sessionId, status: sessionStatus });
      }
    }
  }
}
