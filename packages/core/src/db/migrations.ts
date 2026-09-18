import type Database from 'better-sqlite3';

/** Ordered, transactional migrations. Fail startup visibly instead of running a partial schema. */
export function migrate(db: Database.Database, id: string, apply: () => void): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE id=?').get(id)) return;
  db.transaction(() => {
    apply();
    db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(id, new Date().toISOString());
  })();
}

export function initRuntimeSchema(db: Database.Database): void {
  const columns = new Set((db.pragma('table_info(thread_lifecycle)') as { name: string }[]).map(c => c.name));
  for (const [name, definition] of Object.entries({ generation: 'TEXT', sequence: 'INTEGER NOT NULL DEFAULT -1', turn_id: 'TEXT', turn_open: 'INTEGER NOT NULL DEFAULT 0' })) {
    if (!columns.has(name)) db.exec(`ALTER TABLE thread_lifecycle ADD COLUMN ${name} ${definition}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS harness_generations (
      terminal_id TEXT NOT NULL REFERENCES terminals(id) ON DELETE CASCADE,
      generation TEXT NOT NULL, started_at TEXT NOT NULL,
      PRIMARY KEY(terminal_id,generation)
    );
    CREATE TABLE IF NOT EXISTS lifecycle_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, terminal_id TEXT NOT NULL,
      event_type TEXT NOT NULL, generation TEXT, turn_id TEXT, event_id TEXT,
      observed_at TEXT NOT NULL, status TEXT, disposition TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS lifecycle_events_terminal ON lifecycle_events(terminal_id,id);
    CREATE TABLE IF NOT EXISTS capture_failures (
      terminal_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, observed_at TEXT NOT NULL,
      occurrences INTEGER NOT NULL DEFAULT 1, reason TEXT NOT NULL
    );
  `);
}
