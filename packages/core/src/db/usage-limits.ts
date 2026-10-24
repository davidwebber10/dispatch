import type Database from 'better-sqlite3';

export type ParkState = 'parked' | 'woken' | 'capped';

export interface ParkRow {
  terminal_id: string;
  provider: string;
  kind: 'session' | 'weekly' | 'usage';
  resets_at: number | null;
  wake_at: number;
  message: string;
  parsed: number;
  attempts: number;
  state: ParkState;
  parked_at: number;
  updated_at: number;
}

export function get(db: Database.Database, terminalId: string): ParkRow | null {
  return (db.prepare('SELECT * FROM usage_limit_parks WHERE terminal_id = ?').get(terminalId) as ParkRow | undefined) ?? null;
}

export function upsert(db: Database.Database, row: Omit<ParkRow, 'updated_at'>, now: number): void {
  db.prepare(`
    INSERT INTO usage_limit_parks (terminal_id, provider, kind, resets_at, wake_at, message, parsed, attempts, state, parked_at, updated_at)
    VALUES (@terminal_id, @provider, @kind, @resets_at, @wake_at, @message, @parsed, @attempts, @state, @parked_at, @now)
    ON CONFLICT(terminal_id) DO UPDATE SET provider = @provider, kind = @kind, resets_at = @resets_at, wake_at = @wake_at,
      message = @message, parsed = @parsed, attempts = @attempts, state = @state, parked_at = @parked_at, updated_at = @now
  `).run({ ...row, now });
}

export function setState(db: Database.Database, terminalId: string, state: ParkState, attempts: number, wakeAt: number, now: number): void {
  db.prepare('UPDATE usage_limit_parks SET state = ?, attempts = ?, wake_at = ?, updated_at = ? WHERE terminal_id = ?').run(state, attempts, wakeAt, now, terminalId);
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
