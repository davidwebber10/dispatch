import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as ledgerDb from '../../src/db/ledger.js';

const T0 = '2026-10-05T16:00:00.000Z';
const T1 = '2026-10-05T16:51:00.000Z';

describe('005 migration', () => {
  it('creates both tables and records the migration id', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['coordinator_messages', 'ledger_items']));
    expect(db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get('005-coordinator-messages-and-ledger')).toBeTruthy();
  });

  it('reaches an existing database that predates it', () => {
    const db = new Database(':memory:');
    initSchema(db);
    db.exec("DROP TRIGGER ledger_items_text_immutable; DROP TABLE ledger_items; DROP TABLE coordinator_messages; DELETE FROM schema_migrations WHERE id = '005-coordinator-messages-and-ledger'");
    initSchema(db); // the next boot of an old database
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['coordinator_messages', 'ledger_items']));
  });
});

describe('ledger db', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initSchema(db); });

  const add = (sessionId: string, text: string, extra: Partial<ledgerDb.CreateLedgerInput> = {}) =>
    ledgerDb.create(db, { sessionId, kind: 'decide', text, author: 'overseer', now: T0, ...extra });

  it('counts seq per project, starting at 1', () => {
    expect(add('s1', 'a').seq).toBe(1);
    expect(add('s1', 'b').seq).toBe(2);
    expect(add('s2', 'c').seq).toBe(1);
  });

  it('never repeats a seq, whatever happened to earlier items', () => {
    add('s1', 'a');
    ledgerDb.updateStatus(db, 's1', 1, { status: 'withdrawn', reason: 'moot' });
    expect(add('s1', 'b').seq).toBe(2);
  });

  it('stores every field and reads options back as an array', () => {
    const item = add('s1', 'Which store first?', { recommendation: 'A', options: ['A', 'B'], blocks: 'the import agent', mission: 'Stores' });
    expect(item).toMatchObject({
      sessionId: 's1', seq: 1, kind: 'decide', text: 'Which store first?', author: 'overseer',
      recommendation: 'A', options: ['A', 'B'], blocks: 'the import agent', mission: 'Stores',
      status: 'open', quote: null, origin: 'live', supersedes: null, createdAt: T0, updatedAt: T0,
    });
    expect(ledgerDb.getBySeq(db, 's1', 1)).toEqual(item);
    expect(ledgerDb.getBySeq(db, 's1', 2)).toBeNull();
  });

  it('item text never changes (a trigger rejects any update of it)', () => {
    add('s1', 'Merge PR #12.');
    expect(() => db.prepare("UPDATE ledger_items SET text = 'Merge PR #12 and #13.' WHERE seq = 1").run()).toThrow(/never changes/);
    expect(ledgerDb.getBySeq(db, 's1', 1)!.text).toBe('Merge PR #12.');
  });

  it('updateStatus sets the status and the quote fields, keeps the text, and moves updated_at', () => {
    add('s1', 'Which store first?');
    const out = ledgerDb.updateStatus(db, 's1', 1, { status: 'answered', quote: 'A', quoteMessageId: 7, quoteAt: T1, reading: 'only the first store', now: T1 });
    expect(out).toMatchObject({ status: 'answered', quote: 'A', quoteMessageId: 7, quoteAt: T1, reading: 'only the first store', text: 'Which store first?', updatedAt: T1, createdAt: T0 });
  });

  it('a new item that supersedes an OPEN item marks the old one superseded', () => {
    add('s1', 'Set the first store to Draft?');
    const wider = add('s1', 'Also set the second store to Draft?', { supersedes: 1 });
    expect(wider.supersedes).toBe(1);
    expect(ledgerDb.getBySeq(db, 's1', 1)!.status).toBe('superseded');
  });

  it('a new item that supersedes an ANSWERED item leaves the old answer in place', () => {
    add('s1', 'Set the first store to Draft?');
    ledgerDb.updateStatus(db, 's1', 1, { status: 'answered', quote: 'yes', quoteAt: T1 });
    add('s1', 'Also set the second store to Draft?', { supersedes: 1 });
    expect(ledgerDb.getBySeq(db, 's1', 1)!.status).toBe('answered');
  });

  it('listBySession is in seq order and listOpenSeqs returns only open items', () => {
    add('s1', 'a'); add('s1', 'b'); add('s1', 'c');
    ledgerDb.updateStatus(db, 's1', 2, { status: 'parked', quote: 'later', quoteAt: T1 });
    expect(ledgerDb.listBySession(db, 's1').map((i) => i.seq)).toEqual([1, 2, 3]);
    expect(ledgerDb.listOpenSeqs(db, 's1')).toEqual([1, 3]);
    expect(ledgerDb.listOpenSeqs(db, 's2')).toEqual([]);
  });
});
