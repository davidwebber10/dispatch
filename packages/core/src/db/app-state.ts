import type Database from 'better-sqlite3';

export function get(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function set(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)').run(key, value);
}
