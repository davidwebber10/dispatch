import type Database from 'better-sqlite3';
import * as usageDb from './usage.js';

export interface PtyStateRow {
  terminal_id: string;
  transcript_path: string;
  byte_offset: number;
  last_total_input: number;
  last_total_output: number;
  last_total_cached: number;
  updated_at: string;
}

export function getState(db: Database.Database, terminalId: string): PtyStateRow | null {
  const row = db.prepare('SELECT * FROM usage_pty_state WHERE terminal_id = ?').get(terminalId);
  return (row as PtyStateRow | undefined) ?? null;
}

/**
 * Drop any stored capture state for a terminal. Called when a thread turns
 * structured: the live recorder owns it from that point on, so a stored PTY
 * cursor/total is meaningless, and a stale one would let a later PTY settle
 * re-count whatever the structured period already recorded. A delete of a
 * row that isn't there is harmless, so callers need not check first.
 */
export function deleteState(db: Database.Database, terminalId: string): void {
  db.prepare('DELETE FROM usage_pty_state WHERE terminal_id = ?').run(terminalId);
}

export function putState(db: Database.Database, s: PtyStateRow): void {
  db.prepare(`
    INSERT INTO usage_pty_state
      (terminal_id, transcript_path, byte_offset, last_total_input, last_total_output, last_total_cached, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(terminal_id) DO UPDATE SET
      transcript_path   = excluded.transcript_path,
      byte_offset       = excluded.byte_offset,
      last_total_input  = excluded.last_total_input,
      last_total_output = excluded.last_total_output,
      last_total_cached = excluded.last_total_cached,
      updated_at        = excluded.updated_at
  `).run(s.terminal_id, s.transcript_path, s.byte_offset, s.last_total_input, s.last_total_output, s.last_total_cached, s.updated_at);
}

/**
 * Write the turn row and advance the capture state together.
 *
 * These MUST be one transaction. Row first then a crash re-reads the same range on
 * the next turn and double-counts; state first then a crash silently drops a turn.
 * better-sqlite3's `transaction()` rolls back both on any throw.
 */
export function recordTurn(db: Database.Database, row: usageDb.ClosedTurnInput, state: PtyStateRow): void {
  db.transaction(() => {
    usageDb.insertClosed(db, row);
    putState(db, state);
  })();
}
