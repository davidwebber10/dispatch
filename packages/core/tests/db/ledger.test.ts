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
    const options = [{ label: 'A', effect: 'a' }, { label: 'B', effect: 'b' }];
    const item = add('s1', 'Which store first?', { recommendation: 'A', options, blocks: 'the import agent', mission: 'Stores' });
    expect(item).toMatchObject({
      sessionId: 's1', seq: 1, kind: 'decide', text: 'Which store first?', author: 'overseer',
      recommendation: 'A', options, blocks: 'the import agent', mission: 'Stores',
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

// Decision cards (spec 2026-10-06, Unit 1).
const OLD_005_COLUMNS = ['id', 'session_id', 'seq', 'kind', 'text', 'author', 'recommendation', 'options', 'blocks', 'mission',
  'status', 'quote', 'quote_message_id', 'quote_at', 'reading', 'reason', 'supersedes', 'origin', 'created_at', 'updated_at'];

/** A database as #62 left it: migration 005 applied, 006 not yet. */
function db005(): Database.Database {
  const db = new Database(':memory:');
  initSchema(db);
  db.exec('DROP TRIGGER ledger_items_text_immutable; DROP TABLE ledger_items');
  db.exec(`CREATE TABLE ledger_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
      text TEXT NOT NULL, author TEXT NOT NULL, recommendation TEXT, options TEXT, blocks TEXT, mission TEXT,
      status TEXT NOT NULL DEFAULT 'open', quote TEXT, quote_message_id INTEGER, quote_at TEXT, reading TEXT,
      reason TEXT, supersedes INTEGER, origin TEXT NOT NULL DEFAULT 'live', created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, UNIQUE (session_id, seq));
    CREATE TRIGGER ledger_items_text_immutable BEFORE UPDATE OF text ON ledger_items
      WHEN NEW.text IS NOT OLD.text BEGIN SELECT RAISE(ABORT, 'ledger item text never changes'); END;`);
  db.exec("DELETE FROM schema_migrations WHERE id = '006-ledger-decision-cards'");
  return db;
}

describe('006 migration', () => {
  it('adds the card columns and records the migration id; 005 stays as it was', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const cols = (db.pragma('table_info(ledger_items)') as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      ...OLD_005_COLUMNS, 'context', 'recommendation_why', 'default_text', 'source_kind', 'source_ref', 'source_section',
      'source_id', 'overseer_note', 'on_default_since', 'agent_terminal_id', 'agent_decision_id', 'decided_choice',
      'decided_at', 'policy', 'sent_at',
    ]));
    expect(db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get('006-ledger-decision-cards')).toBeTruthy();
  });

  it('reaches an existing #62 database: old rows keep their data, read plain-string options, and count as sent', () => {
    const db = db005();
    db.prepare(`INSERT INTO ledger_items (session_id, seq, kind, text, author, recommendation, options, status, created_at, updated_at)
      VALUES ('s1', 1, 'decide', 'Which store goes first?', 'overseer', 'A', '["A","B"]', 'open', ?, ?)`).run(T0, T0);
    initSchema(db); // the next boot of a #62 database
    const item = ledgerDb.getBySeq(db, 's1', 1)!;
    expect(item).toMatchObject({
      text: 'Which store goes first?', recommendation: 'A', status: 'open',
      options: [{ label: 'A', effect: '' }, { label: 'B', effect: '' }],
      context: null, defaultText: null, sourceKind: null, policy: false, sentAt: T0,
    });
    // The text trigger survives the migration.
    expect(() => db.prepare("UPDATE ledger_items SET text = 'x' WHERE seq = 1").run()).toThrow(/never changes/);
  });
});

// Titles and source panel spec 2026-10-09, Unit 1: a nullable title column.
describe('007 migration', () => {
  it('adds a nullable title column; rows that exist keep NULL', () => {
    const db = new Database(':memory:');
    initSchema(db);
    db.exec('ALTER TABLE ledger_items DROP COLUMN title');
    db.exec("DELETE FROM schema_migrations WHERE id = '007-ledger-title'");
    db.prepare(`INSERT INTO ledger_items (session_id, seq, kind, text, author, status, created_at, updated_at)
      VALUES ('s1', 1, 'decide', 'Which store goes first?', 'overseer', 'open', ?, ?)`).run(T0, T0);
    initSchema(db); // the next boot of a database from before titles
    expect(db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get('007-ledger-title')).toBeTruthy();
    expect(ledgerDb.getBySeq(db, 's1', 1)).toMatchObject({ text: 'Which store goes first?', title: null });
  });

  it('create stores the title; without one it is null', () => {
    const db = new Database(':memory:');
    initSchema(db);
    expect(ledgerDb.create(db, { sessionId: 's1', kind: 'go', text: 'Merge board PR #26?', title: 'Merge board PR #26', author: 'overseer', now: T0 }).title)
      .toBe('Merge board PR #26');
    expect(ledgerDb.create(db, { sessionId: 's1', kind: 'do', text: 'Check staging.', author: 'overseer', now: T0 }).title).toBeNull();
  });
});

describe('ledger db — card fields', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initSchema(db); });

  it('stores every card field and reads options back as { label, effect }', () => {
    const item = ledgerDb.create(db, {
      sessionId: 's1', kind: 'decide', text: 'How many clean nights before live mode?', author: 'Readiness planner',
      context: 'The new sync runs in shadow mode.',
      options: [{ label: 'A. 5 nights', effect: 'Covers one weekend.' }, { label: 'B. 10 nights', effect: 'Covers two weekends.' }],
      recommendation: 'A. 5 nights', recommendationWhy: 'The weekend pattern is the known risk.',
      defaultText: 'Nothing switches.', sourceKind: 'agent', sourceRef: 'Readiness planner',
      sourceSection: 'docs/plans/readiness.md#Owner decisions', sourceId: 'LR-6', overseerNote: 'Check the dates.',
      agentTerminalId: 'agent-1', agentDecisionId: 'LR-6', status: 'proposed', now: T0,
    });
    expect(item).toMatchObject({
      status: 'proposed', context: 'The new sync runs in shadow mode.',
      options: [{ label: 'A. 5 nights', effect: 'Covers one weekend.' }, { label: 'B. 10 nights', effect: 'Covers two weekends.' }],
      recommendation: 'A. 5 nights', recommendationWhy: 'The weekend pattern is the known risk.', defaultText: 'Nothing switches.',
      sourceKind: 'agent', sourceRef: 'Readiness planner', sourceSection: 'docs/plans/readiness.md#Owner decisions', sourceId: 'LR-6',
      overseerNote: 'Check the dates.', agentTerminalId: 'agent-1', agentDecisionId: 'LR-6',
      onDefaultSince: null, decidedChoice: null, decidedAt: null, policy: false,
      sentAt: null, // a proposed item has not been sent to the user
    });
    expect(ledgerDb.getBySeq(db, 's1', 1)).toEqual(item);
  });

  it('an item created open counts as sent at its creation; a policy statement keeps policy', () => {
    expect(ledgerDb.create(db, { sessionId: 's1', kind: 'go', text: 'Merge PR #12.', author: 'overseer', now: T0 }).sentAt).toBe(T0);
    const rule = ledgerDb.create(db, { sessionId: 's1', kind: 'statement', text: 'never on Fridays', author: 'you', status: 'answered', policy: true, now: T0 });
    expect(rule.policy).toBe(true);
  });

  it('a malformed options value reads as none; mixed shapes are normalized', () => {
    ledgerDb.create(db, { sessionId: 's1', kind: 'decide', text: 'a', author: 'overseer', now: T0 });
    db.prepare("UPDATE ledger_items SET options = 'not json' WHERE seq = 1").run();
    expect(ledgerDb.getBySeq(db, 's1', 1)!.options).toBeNull();
    db.prepare(`UPDATE ledger_items SET options = '["A", {"label":"B","effect":"b"}, {"nope":1}]' WHERE seq = 1`).run();
    expect(ledgerDb.getBySeq(db, 's1', 1)!.options).toEqual([{ label: 'A', effect: '' }, { label: 'B', effect: 'b' }]);
  });

  it('listProposedSeqs returns only proposed items; listOpenSeqs leaves them out', () => {
    ledgerDb.create(db, { sessionId: 's1', kind: 'decide', text: 'a', author: 'overseer', now: T0 });
    ledgerDb.create(db, { sessionId: 's1', kind: 'decide', text: 'b', author: 'planner', status: 'proposed', now: T0 });
    ledgerDb.create(db, { sessionId: 's1', kind: 'decide', text: 'c', author: 'planner', status: 'proposed', now: T0 });
    expect(ledgerDb.listOpenSeqs(db, 's1')).toEqual([1]);
    expect(ledgerDb.listProposedSeqs(db, 's1')).toEqual([2, 3]);
  });

  it('a new item that supersedes a PROPOSED item marks the old one superseded', () => {
    ledgerDb.create(db, { sessionId: 's1', kind: 'decide', text: 'old question', author: 'planner', status: 'proposed', now: T0 });
    ledgerDb.create(db, { sessionId: 's1', kind: 'decide', text: 'new question', author: 'planner', status: 'proposed', supersedes: 1, now: T0 });
    expect(ledgerDb.getBySeq(db, 's1', 1)!.status).toBe('superseded');
  });
});
