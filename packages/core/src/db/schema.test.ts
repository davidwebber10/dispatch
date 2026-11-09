import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from './schema.js';

describe('initSchema: indexes (W1-E)', () => {
  const indexes = (db: Database.Database, table: string) =>
    (db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?").all(table) as { name: string; sql: string | null }[]);
  const plan = (db: Database.Database, sql: string) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join(' | ');

  test('the four indexes exist', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const t = indexes(db, 'terminals').map((i) => i.name);
    const r = indexes(db, 'agent_runs').map((i) => i.name);
    expect(t).toContain('idx_terminals_session_id');
    expect(t).toContain('idx_terminals_status');
    expect(r).toContain('idx_agent_runs_terminal_id');
    expect(r).toContain('idx_agent_runs_schedule_id');
    expect(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'w1e-indexes'").get()).toBeTruthy();
    db.close();
  });

  test('the four lookups use their index', () => {
    const db = new Database(':memory:');
    initSchema(db);
    expect(plan(db, "SELECT * FROM terminals WHERE session_id = 's'")).toContain('USING INDEX idx_terminals_session_id');
    expect(plan(db, "SELECT * FROM terminals WHERE status = 'working'")).toContain('USING INDEX idx_terminals_status');
    expect(plan(db, "SELECT * FROM agent_runs WHERE terminal_id = 't'")).toContain('USING INDEX idx_agent_runs_terminal_id');
    expect(plan(db, "SELECT * FROM agent_runs WHERE schedule_id = 'x'")).toContain('USING INDEX idx_agent_runs_schedule_id');
    db.close();
  });

  test('a second initSchema on the same database is safe', () => {
    const db = new Database(':memory:');
    initSchema(db);
    expect(() => initSchema(db)).not.toThrow();
    expect(indexes(db, 'terminals').filter((i) => i.name === 'idx_terminals_status')).toHaveLength(1);
    db.close();
  });
});
