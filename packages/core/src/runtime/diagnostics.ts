import type Database from 'better-sqlite3';

/** Rows kept per terminal after a trim. */
const KEEP_ROWS = 200;
/** The trim runs on each 50th insert of a terminal, so a terminal holds at most 200 + 49 rows. */
const TRIM_EVERY = 50;

interface LifecycleLog {
  insert: Database.Statement;
  trim: Database.Statement;
  /** Inserts per terminal since this process opened the database. */
  inserts: Map<string, number>;
}
/** Per database: the two prepared statements and the insert counts. */
const logs = new WeakMap<Database.Database, LifecycleLog>();

function lifecycleLog(db: Database.Database): LifecycleLog {
  let log = logs.get(db);
  if (!log) {
    log = {
      insert: db.prepare(`INSERT INTO lifecycle_events(terminal_id,event_type,generation,turn_id,event_id,observed_at,status,disposition)
        VALUES (?,?,?,?,?,?,(SELECT status FROM terminals WHERE id=?),?)`),
      trim: db.prepare(`DELETE FROM lifecycle_events WHERE terminal_id=? AND id NOT IN
        (SELECT id FROM lifecycle_events WHERE terminal_id=? ORDER BY id DESC LIMIT ${KEEP_ROWS})`),
      inserts: new Map(),
    };
    logs.set(db, log);
  }
  return log;
}

/**
 * Metadata only: no prompts, tool arguments, credentials, or native frame bodies.
 *
 * The trim `DELETE` ran after every insert; it now runs on each 50th insert of a terminal (W1-E), so a
 * status event costs one statement, not two. Readers take the newest 200 rows or a MIN/MAX, so up to
 * 49 more rows change no answer.
 */
export function logLifecycle(db: Database.Database, event: { terminalId: string; type: string; observedAt: string; generation?: string; turnId?: string; eventId?: string }, disposition: string): void {
  const log = lifecycleLog(db);
  log.insert.run(event.terminalId,event.type,event.generation ?? null,event.turnId ?? null,event.eventId ?? null,event.observedAt,event.terminalId,disposition);
  const n = (log.inserts.get(event.terminalId) ?? 0) + 1;
  log.inserts.set(event.terminalId, n);
  if (n % TRIM_EVERY === 0) log.trim.run(event.terminalId,event.terminalId);
}

export function recordCaptureFailure(db: Database.Database, terminalId: string, type: string, error: unknown): void {
  if (!db.open) return;
  const reason = error instanceof Error ? error.message : 'Unknown capture failure';
  db.prepare(`INSERT INTO capture_failures VALUES (?,?,?,1,?) ON CONFLICT(terminal_id) DO UPDATE SET
    event_type=excluded.event_type, observed_at=excluded.observed_at, occurrences=occurrences+1, reason=excluded.reason`)
    .run(terminalId,type,new Date().toISOString(),reason.slice(0,300));
  db.prepare("UPDATE usage_turns SET coverage='partial' WHERE terminal_id=? AND ended_at IS NULL").run(terminalId);
}
