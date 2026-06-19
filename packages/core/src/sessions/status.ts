import type Database from 'better-sqlite3';
import type { SessionStatus, SessionRow } from '../types.js';
import { getProvider } from '../providers/registry.js';
import type { PTYManager } from '../pty/manager.js';
import type { EventBroadcaster } from '../ws/events.js';
import * as sessionsDb from '../db/sessions.js';

const ACTIVITY_THRESHOLD_MS = 10_000;
const DEFAULT_INTERVAL_MS = 5_000;

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
 * Starts a polling loop that checks PTY activity for providers using pty-timing.
 * Returns the interval ID for cleanup.
 */
export function startPtyTimingLoop(
  db: Database.Database,
  ptyManager: PTYManager,
  broadcaster: EventBroadcaster,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): NodeJS.Timeout {
  return setInterval(() => {
    // Get all non-done, non-archived sessions
    const rows = db.prepare(
      "SELECT * FROM sessions WHERE status != 'done' AND archived_at IS NULL AND pid IS NOT NULL",
    ).all() as SessionRow[];

    for (const row of rows) {
      let provider;
      try {
        provider = getProvider(row.provider);
      } catch {
        continue;
      }

      if (provider.statusStrategy !== 'pty-timing') continue;

      const lastActivity = ptyManager.getLastActivity(row.id);
      const isAlive = ptyManager.isAlive(row.id);

      let newStatus: SessionStatus | null = null;

      if (lastActivity) {
        const elapsed = Date.now() - lastActivity.getTime();
        if (elapsed <= ACTIVITY_THRESHOLD_MS) {
          newStatus = 'working';
        } else if (isAlive) {
          newStatus = 'waiting';
        }
      } else if (isAlive) {
        newStatus = 'waiting';
      }

      if (newStatus && newStatus !== row.status) {
        sessionsDb.updateStatus(db, row.id, newStatus);
        broadcaster.broadcast({
          type: 'session:status',
          sessionId: row.id,
          status: newStatus,
        });
      }
    }
  }, intervalMs);
}
