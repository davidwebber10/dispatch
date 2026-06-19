import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as appState from '../../src/db/app-state.js';

describe('app-state db', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initSchema(db); });

  it('gets null for missing key', () => {
    expect(appState.get(db, 'missing')).toBeNull();
  });

  it('sets and gets a value', () => {
    appState.set(db, 'last_directory', '/tmp/foo');
    expect(appState.get(db, 'last_directory')).toBe('/tmp/foo');
  });

  it('upserts on set', () => {
    appState.set(db, 'key', 'a');
    appState.set(db, 'key', 'b');
    expect(appState.get(db, 'key')).toBe('b');
  });
});
