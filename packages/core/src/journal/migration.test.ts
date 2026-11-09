import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import { MessageJournal } from './journal.js';

// The migration `w3d-thread-journal` on a database that an older daemon made.
describe('migration w3d-thread-journal', () => {
  it('adds the table to an existing database and keeps its rows', () => {
    const db = new Database(':memory:');
    initSchema(db);
    // Make the database look like one from before the journal: no table, no migration record.
    db.exec('DROP TABLE thread_journal');
    db.exec("DROP TRIGGER IF EXISTS thread_journal_thread_deleted");
    db.prepare("DELETE FROM schema_migrations WHERE id = 'w3d-thread-journal'").run();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO sessions (id, provider, name, working_dir, created_at, updated_at, last_activity_at) VALUES ('s','claude-code','s','/tmp',?,?,?)").run(now, now, now);
    db.prepare("INSERT INTO terminals (id, session_id, type, label, created_at) VALUES ('t1', 's', 'grok', 'kept', ?)").run(now);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'thread_journal'").get()).toBeUndefined();

    initSchema(db); // the new daemon starts

    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'thread_journal'").get()).toBeDefined();
    expect(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'w3d-thread-journal'").get()).toBeDefined();
    expect((db.prepare("SELECT label FROM terminals WHERE id = 't1'").get() as { label: string }).label).toBe('kept');
    const j = new MessageJournal(db);
    expect(j.lastSeq('t1')).toBe(0); // an existing thread starts with an empty journal
    expect(j.append('t1', { kind: 'user', payload: { type: 'user' } })).toBe(1);
  });

  it('runs once: a second start keeps the journal rows', () => {
    const db = new Database(':memory:');
    initSchema(db);
    new MessageJournal(db).append('t1', { kind: 'user', payload: { type: 'user' } });
    initSchema(db);
    initSchema(db);
    expect(new MessageJournal(db).lastSeq('t1')).toBe(1);
  });

  it('has the primary key, the two unique indexes and the delete trigger', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const cols = (db.pragma('table_info(thread_journal)') as { name: string; pk: number }[]);
    expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(['terminal_id', 'seq', 'kind', 'native_id', 'payload', 'idem_key', 'at']));
    expect(cols.filter((c) => c.pk > 0).map((c) => c.name).sort()).toEqual(['seq', 'terminal_id']);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE tbl_name = 'thread_journal' OR name LIKE 'thread_journal%'").all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['idx_thread_journal_idem', 'idx_thread_journal_native', 'thread_journal_thread_deleted']));
    const insert = db.prepare("INSERT INTO thread_journal (terminal_id, seq, kind, payload, idem_key, at) VALUES (?, ?, 'user', '{}', ?, 'now')");
    insert.run('a', 1, 'k');
    expect(() => insert.run('a', 2, 'k')).toThrow(/UNIQUE/);
    expect(() => insert.run('a', 1, null)).toThrow(/UNIQUE|PRIMARY/);
    insert.run('a', 3, null);
    insert.run('a', 4, null); // a null key is not unique
  });
});
