import type Database from 'better-sqlite3';

/** Metadata only: no prompts, tool arguments, credentials, or native frame bodies. */
export function logLifecycle(db: Database.Database, event: { terminalId: string; type: string; observedAt: string; generation?: string; turnId?: string; eventId?: string }, disposition: string): void {
  db.prepare(`INSERT INTO lifecycle_events(terminal_id,event_type,generation,turn_id,event_id,observed_at,status,disposition)
    VALUES (?,?,?,?,?,?,(SELECT status FROM terminals WHERE id=?),?)`)
    .run(event.terminalId,event.type,event.generation ?? null,event.turnId ?? null,event.eventId ?? null,event.observedAt,event.terminalId,disposition);
  db.prepare(`DELETE FROM lifecycle_events WHERE terminal_id=? AND id NOT IN
    (SELECT id FROM lifecycle_events WHERE terminal_id=? ORDER BY id DESC LIMIT 200)`).run(event.terminalId,event.terminalId);
}

export function recordCaptureFailure(db: Database.Database, terminalId: string, type: string, error: unknown): void {
  if (!db.open) return;
  const reason = error instanceof Error ? error.message : 'Unknown capture failure';
  db.prepare(`INSERT INTO capture_failures VALUES (?,?,?,1,?) ON CONFLICT(terminal_id) DO UPDATE SET
    event_type=excluded.event_type, observed_at=excluded.observed_at, occurrences=occurrences+1, reason=excluded.reason`)
    .run(terminalId,type,new Date().toISOString(),reason.slice(0,300));
  db.prepare("UPDATE usage_turns SET coverage='partial' WHERE terminal_id=? AND ended_at IS NULL").run(terminalId);
}
