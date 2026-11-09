import { describe, expect, test, vi } from 'vitest';
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

  // W1-E. better-sqlite3 already gives these two values by default; the code now sets them, so a
  // change of that default cannot change the daemon.
  test('synchronous is NORMAL and busy_timeout is 5000', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-db-'));
    const db = createDatabase(path.join(dir, 'dispatch.db'));
    expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    expect(db.pragma('synchronous', { simple: true })).toBe(1); // 1 = NORMAL
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a database that did not get WAL keeps synchronous FULL', () => {
    // NORMAL is safe only with WAL. With a rollback journal it can corrupt the file on a power loss.
    // An in-memory database cannot use WAL, so it takes the same path as a network filesystem.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = createDatabase(':memory:');
    expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).not.toBe('wal');
    expect(db.pragma('synchronous', { simple: true })).toBe(2); // 2 = FULL
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    db.close();
    warn.mockRestore();
  });
});
