import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from './connection.js';

describe('createDatabase', () => {
  test('uses WAL on a local filesystem and applies the schema', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-db-'));
    const db = createDatabase(path.join(dir, 'dispatch.db'));
    expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    // foreign_keys must survive the journal-mode negotiation above it.
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() => db.prepare('SELECT id FROM sessions').all()).not.toThrow();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a local open does not leave the connection in EXCLUSIVE locking mode', () => {
    // The EXCLUSIVE fallback is only for network filesystems; applying it locally
    // would stop anyone opening dispatch.db in a second process to inspect it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-db-'));
    const p = path.join(dir, 'dispatch.db');
    const db = createDatabase(p);
    db.prepare("INSERT INTO app_state (key, value) VALUES ('k','v')").run();
    const second = new (require('better-sqlite3'))(p, { readonly: true });
    expect(() => second.prepare('SELECT value FROM app_state').all()).not.toThrow();
    second.close(); db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
