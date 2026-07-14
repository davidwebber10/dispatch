import type Database from 'better-sqlite3';
import type { SessionService } from './service.js';
import type { EventBroadcaster } from '../ws/events.js';
import * as terminalsDb from '../db/terminals.js';

/** Default inactivity deadline: 12 hours. */
export const DEFAULT_AUTO_ARCHIVE_MS = 43_200_000;

const DEFAULT_INTERVAL_MS = 60_000;

export interface AutoArchivePolicy {
  autoArchive: true;
  autoArchiveMs: number;
}

/**
 * A thread is swept only when NOBODY is blocked on it — not the system, not the
 * user. 'working' is mid-turn (a thinking agent can be silent for a long time);
 * 'queued' is waiting on a dependsOn agent; 'scheduled' is parked for a future
 * wake; 'needs_input' is blocked on the user at a permission prompt. Archiving
 * any of those would kill work somebody is still waiting for.
 */
export const SWEEPABLE_STATUSES: readonly string[] = ['waiting', 'error'];

/**
 * The thread's deadline in ms, or null if it never opted in. An enabled policy
 * with a missing/invalid duration falls back to the 12h default rather than
 * being treated as "archive immediately".
 */
export function getAutoArchiveMs(config: Record<string, any>): number | null {
  if (!config || config.autoArchive !== true) return null;
  const ms = config.autoArchiveMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return DEFAULT_AUTO_ARCHIVE_MS;
  return ms;
}

/**
 * Read-merge-write helper. `terminalsDb.updateConfig` REPLACES the whole blob,
 * so callers must never hand it a partial config — doing so would silently drop
 * `transport`, `role`, `agentType`, etc. Disabling strips both keys rather than
 * leaving `autoArchive: false` noise behind.
 */
export function withAutoArchive(
  config: Record<string, any>,
  enabled: boolean,
  ms: number = DEFAULT_AUTO_ARCHIVE_MS,
): Record<string, any> {
  const next = { ...(config ?? {}) };
  if (enabled) {
    next.autoArchive = true;
    next.autoArchiveMs = (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) ? ms : DEFAULT_AUTO_ARCHIVE_MS;
  } else {
    delete next.autoArchive;
    delete next.autoArchiveMs;
  }
  return next;
}

/**
 * One sweep pass (exported for tests — no timers involved). Archives every
 * opted-in thread that is past its inactivity deadline and that nothing is
 * blocked on. Returns the ids it archived.
 *
 * Archiving goes through SessionService.removeTerminal — the SAME method the
 * DELETE route calls — so auto-archive and manual archive are one operation and
 * cannot drift. It emits the same two frames the DELETE route emits, which the
 * frontend already handles, so the sidebar row vanishes live.
 */
export function autoArchiveTick(
  db: Database.Database,
  sessionService: Pick<SessionService, 'removeTerminal'>,
  broadcaster: EventBroadcaster,
  now: number = Date.now(),
): string[] {
  const archived: string[] = [];

  let rows: terminalsDb.TerminalRow[];
  try {
    rows = db.prepare('SELECT * FROM terminals WHERE archived_at IS NULL').all() as terminalsDb.TerminalRow[];
  } catch (err) {
    // Most likely the DB closing mid-shutdown, not a real failure — log it
    // quietly so a genuinely broken query doesn't look identical to "nothing
    // to archive", but don't make noise about it.
    console.error('auto-archive: sweep query failed (DB may be closing)', err);
    return archived;
  }

  for (const row of rows) {
    // One bad thread must never abort the sweep for the rest.
    try {
      const terminal = terminalsDb.rowToTerminal(row);   // malformed config parses to {}
      if (!terminalsDb.isPtyType(terminal.type)) continue; // no activity signal → never sweep
      const deadlineMs = getAutoArchiveMs(terminal.config);
      if (deadlineMs === null) continue;                 // did not opt in
      if (!SWEEPABLE_STATUSES.includes(terminal.status)) continue;

      const lastActive = Date.parse(terminal.lastActivityAt);
      if (!Number.isFinite(lastActive)) continue;        // unparseable clock — leave it alone
      if (now - lastActive < deadlineMs) continue;       // still inside its lease

      sessionService.removeTerminal(terminal.id);
      archived.push(terminal.id);
      broadcaster.broadcast({ type: 'terminal:removed', terminalId: terminal.id, sessionId: terminal.sessionId });
      broadcaster.broadcast({ type: 'session:tabs-changed', sessionId: terminal.sessionId });
    } catch (err) {
      console.error(`auto-archive: failed to sweep terminal ${row.id}`, err);
    }
  }

  return archived;
}

/** Start the sweep loop. Returns the interval id for cleanup. */
export function startAutoArchiveLoop(
  db: Database.Database,
  sessionService: SessionService,
  broadcaster: EventBroadcaster,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): NodeJS.Timeout {
  return setInterval(() => {
    try {
      autoArchiveTick(db, sessionService, broadcaster);
    } catch (err) {
      console.error('auto-archive sweep failed', err);
    }
  }, intervalMs);
}
