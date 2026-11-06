import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from './schema.js';
import * as parksDb from './usage-limits.js';

describe('usage_limit_parks.detected_at migration', () => {
  it('adds the column to a table from 3.11.0 and backfills it from parked_at', () => {
    const db = new Database(':memory:');
    // The table exactly as 3.11.0 created it, with a row in it.
    db.exec(`CREATE TABLE usage_limit_parks (
      terminal_id TEXT PRIMARY KEY, provider TEXT NOT NULL, kind TEXT NOT NULL, resets_at INTEGER, wake_at INTEGER NOT NULL,
      message TEXT NOT NULL, parsed INTEGER NOT NULL DEFAULT 1, attempts INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'parked',
      parked_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    db.prepare("INSERT INTO usage_limit_parks VALUES ('t', 'claude-code', 'session', NULL, 5, 'm', 0, 1, 'parked', 1234, 1234)").run();
    initSchema(db);
    expect(parksDb.get(db, 't')!.detected_at).toBe(1234);
    expect(parksDb.get(db, 't')!.cleared_at).toBeNull(); // migration 017
    initSchema(db); // idempotent
    expect(parksDb.get(db, 't')!.detected_at).toBe(1234);
    expect(parksDb.get(db, 't')!.cleared_at).toBeNull();
    db.close();
  });
});
