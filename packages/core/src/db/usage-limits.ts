import type Database from 'better-sqlite3';
import type { LimitKind } from '../limits/detect.js';

export type ParkState = 'parked' | 'woken' | 'capped';

export interface ParkRow {
  terminal_id: string;
  provider: string;
  kind: LimitKind;
  resets_at: number | null;
  wake_at: number;
  message: string;
  parsed: number;
  attempts: number;
  state: ParkState;
  /** The start of the chain: kept across a resume that hits the limit again. */
  parked_at: number;
  /** When a limit was last detected for this row (renewed on every detection). Clearing figures must be newer. */
  detected_at: number;
  /** When a limit with no read reset time was seen to clear. Null until then, and again after a new detection. */
  cleared_at: number | null;
  updated_at: number;
}

export function get(db: Database.Database, terminalId: string): ParkRow | null {
  return (db.prepare('SELECT * FROM usage_limit_parks WHERE terminal_id = ?').get(terminalId) as ParkRow | undefined) ?? null;
}

export function upsert(db: Database.Database, row: Omit<ParkRow, 'updated_at' | 'detected_at' | 'cleared_at'> & { detected_at?: number }, now: number): void {
  db.prepare(`
    INSERT INTO usage_limit_parks (terminal_id, provider, kind, resets_at, wake_at, message, parsed, attempts, state, parked_at, detected_at, updated_at)
    VALUES (@terminal_id, @provider, @kind, @resets_at, @wake_at, @message, @parsed, @attempts, @state, @parked_at, @detected_at, @now)
    ON CONFLICT(terminal_id) DO UPDATE SET provider = @provider, kind = @kind, resets_at = @resets_at, wake_at = @wake_at,
      message = @message, parsed = @parsed, attempts = @attempts, state = @state, parked_at = @parked_at, detected_at = @detected_at, cleared_at = NULL, updated_at = @now
  `).run({ ...row, detected_at: row.detected_at ?? row.parked_at, now });
}

export function setState(db: Database.Database, terminalId: string, state: ParkState, attempts: number, wakeAt: number, now: number): void {
  db.prepare('UPDATE usage_limit_parks SET state = ?, attempts = ?, wake_at = ?, updated_at = ? WHERE terminal_id = ?').run(state, attempts, wakeAt, now, terminalId);
}

/** The last wake try failed to send, so the limit is taken as over: stamp the time on a row that never had a readable reset. A reset that was read is kept. */
export function markLimitOver(db: Database.Database, terminalId: string, now: number): void {
  db.prepare('UPDATE usage_limit_parks SET resets_at = COALESCE(resets_at, ?) WHERE terminal_id = ?').run(now, terminalId);
}

/** Keep the evidence that the limit cleared, for the detection it was seen under. A newer detection has replaced the row's detected_at, so it is not marked. */
export function markCleared(db: Database.Database, terminalId: string, detectedAt: number, at: number): void {
  db.prepare('UPDATE usage_limit_parks SET cleared_at = ? WHERE terminal_id = ? AND detected_at = ?').run(at, terminalId, detectedAt);
}

export function remove(db: Database.Database, terminalId: string): boolean {
  return db.prepare('DELETE FROM usage_limit_parks WHERE terminal_id = ?').run(terminalId).changes > 0;
}

/** Parks waiting for their reset, earliest first. */
export function listDue(db: Database.Database, now: number): ParkRow[] {
  return db.prepare("SELECT * FROM usage_limit_parks WHERE state = 'parked' AND wake_at <= ? ORDER BY wake_at ASC").all(now) as ParkRow[];
}

export function listActive(db: Database.Database): ParkRow[] {
  return db.prepare("SELECT * FROM usage_limit_parks WHERE state = 'parked' ORDER BY wake_at ASC").all() as ParkRow[];
}

/** Threads still stopped on a limit: waiting for the reset (`parked`) or given up (`capped`). Oldest pause first. */
export function listPaused(db: Database.Database): ParkRow[] {
  return db.prepare("SELECT * FROM usage_limit_parks WHERE state IN ('parked', 'capped') ORDER BY parked_at ASC, terminal_id ASC").all() as ParkRow[];
}
