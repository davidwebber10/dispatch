import { StatusService } from '../status/service.js';
import type Database from 'better-sqlite3';
import type { SessionStatus } from '../types.js';
import type { PTYManager } from '../pty/manager.js';
import type { EventBroadcaster } from '../ws/events.js';
import * as terminalsDb from '../db/terminals.js';
import { getProvider } from '../providers/registry.js';

// Output timing is an inferred fallback for terminals without native lifecycle
// observations. Silence or a terminal redraw cannot override an authoritative event.
const ACTIVITY_THRESHOLD_MS = 4_000;
const DEFAULT_INTERVAL_MS = 2_000;

/**
 * Drives live thread (terminal) status from PTY activity. Modern PTYs are keyed
 * by terminal id, so we walk the live PTYs directly rather than the sessions
 * table (whose ids don't match the PTY map). Each interactive terminal is marked
 * `working` while its PTY is active and `waiting` once it goes quiet; a
 * native status is kept authoritative even when output resumes. Session status is
 * then rolled up from its terminals. Returns the interval id for cleanup.
 */
export function startPtyTimingLoop(
  db: Database.Database,
  ptyManager: PTYManager,
  broadcaster: EventBroadcaster,
  intervalMs: number = DEFAULT_INTERVAL_MS,
  lifecycle?: StatusService,
): NodeJS.Timeout {
  return setInterval(() => ptyStatusTick(db, ptyManager, broadcaster, lifecycle), intervalMs);
}

/** One pass of the activity → status reconciliation (exported for tests). */
export function ptyStatusTick(
  db: Database.Database,
  ptyManager: PTYManager,
  broadcaster: EventBroadcaster,
  lifecycle?: StatusService,
): void {
  {
    const now = Date.now();
    let detached: StatusService | undefined;

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

      // Native/input lifecycle events outrank output timing, including redraws after completion.
      if (db.prepare('SELECT 1 FROM thread_lifecycle WHERE terminal_id=? AND source=?').get(id, 'authoritative')) continue;

      const last = ptyManager.getLastActivity(id);
      const recent = !!last && now - last.getTime() <= ACTIVITY_THRESHOLD_MS;
      const current = term.status || 'waiting';
      const next: SessionStatus = recent
        ? 'working'
        : current === 'needs_input' ? 'needs_input' : 'waiting';

      // `next` differs from `current` only as working <-> waiting: a `needs_input` row keeps its status above.
      // StatusService is the one writer of the status (W3-C). A caller with no service (a test) gets a detached one.
      if (next !== current && next !== 'needs_input') {
        (lifecycle ?? (detached ??= StatusService.detached(db, broadcaster))).markInferred(id, next);
      }
    }
  }
}
