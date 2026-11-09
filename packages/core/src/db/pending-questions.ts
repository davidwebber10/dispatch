import type Database from 'better-sqlite3';

/**
 * The question a thread waits on (engineering program W2-C). The pending question of a structured
 * thread lives in the memory of its manager, so a daemon restart lost it. A row is written when
 * the question is asked and removed when it is resolved. One row per thread.
 */
export interface PendingQuestionRow {
  terminal_id: string;
  request_id: string | null;
  /** The PendingPermission as JSON (requestId, toolName, input, questions). */
  payload: string;
  created_at: string;
}

export function put(db: Database.Database, terminalId: string, requestId: string | null, payload: unknown): void {
  db.prepare(`INSERT INTO pending_questions (terminal_id, request_id, payload, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(terminal_id) DO UPDATE SET request_id = excluded.request_id, payload = excluded.payload, created_at = excluded.created_at`)
    .run(terminalId, requestId, JSON.stringify(payload ?? null), new Date().toISOString());
}

export function get(db: Database.Database, terminalId: string): PendingQuestionRow | undefined {
  return db.prepare('SELECT * FROM pending_questions WHERE terminal_id = ?').get(terminalId) as PendingQuestionRow | undefined;
}

export function remove(db: Database.Database, terminalId: string): boolean {
  return db.prepare('DELETE FROM pending_questions WHERE terminal_id = ?').run(terminalId).changes > 0;
}

export function list(db: Database.Database): PendingQuestionRow[] {
  return db.prepare('SELECT * FROM pending_questions ORDER BY created_at ASC, terminal_id ASC').all() as PendingQuestionRow[];
}
