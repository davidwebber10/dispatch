// The title of a ledger item (titles and source panel spec 2026-10-09, Unit 1): a short label the
// overseer writes. The question (`text`) does not change; chips, card rows and recap lines show the
// title. A bad title is a 422 with the reason, in the shape of the other card-field errors.
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as ledgerDb from '../../src/db/ledger.js';
import { LedgerService, LedgerError } from '../../src/overseer/ledger-service.js';
import {
  TITLE_MAX, TITLE_CODE_ONLY_ERROR, TITLE_MISSING_ERROR, TITLE_ONE_LINE_ERROR, TITLE_TWO_WORDS_ERROR, titleProblem, titleTooLongError,
} from '../../src/overseer/ledger-checks.js';
import { DECIDE_CARD, GO_CARD } from './card-fixtures.js';

describe('the title rules', () => {
  it('a short label of 2 words or more, on one line, passes', () => {
    for (const title of ['Merge board PR #26', 'Clean nights before live mode', 'A11 (import confirmation)', 'Q12 approval', 'Rotate the test key']) {
      expect(titleProblem(title), title).toBeNull();
    }
  });

  it('at most 50 characters', () => {
    expect(TITLE_MAX).toBe(50);
    expect(titleProblem(`Merge ${'x'.repeat(44)}`)).toBeNull(); // 50
    const long = `Merge ${'x'.repeat(45)}`; // 51
    expect(titleProblem(long)).toBe(titleTooLongError(51));
    expect(titleTooLongError(51)).toBe('The title has 51 characters; the most is 50 (about 40 is best). Fix it and try again.');
  });

  it('one line', () => {
    expect(titleProblem('Merge the\nboard PR')).toBe(TITLE_ONE_LINE_ERROR);
    expect(titleProblem('Merge the\r\nboard PR')).toBe(TITLE_ONE_LINE_ERROR);
    expect(TITLE_ONE_LINE_ERROR).toBe('The title must be one line. Fix it and try again.');
  });

  it('at least 2 words; punctuation alone is not a word', () => {
    expect(titleProblem('Merge')).toBe(TITLE_TWO_WORDS_ERROR);
    expect(titleProblem('Merge —')).toBe(TITLE_TWO_WORDS_ERROR);
    expect(TITLE_TWO_WORDS_ERROR).toBe('The title needs at least 2 words. Fix it and try again.');
  });

  it('not only a code: N-numbers, plan codes and bare numbers', () => {
    for (const title of ['N41 Q12', 'LR-6 · N41', '(A11) LR-6,', 'n41 #26']) {
      expect(titleProblem(title), title).toBe(TITLE_CODE_ONLY_ERROR);
    }
    expect(TITLE_CODE_ONLY_ERROR).toBe('The title must say what the item is, not only a code such as N41 or LR-6. Fix it and try again.');
  });
});

describe('the title on the ledger service', () => {
  let db: Database.Database;
  let ledger: LedgerService;
  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
    terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
    ledger = new LedgerService(db, { clock: () => Date.parse('2026-10-09T10:00:00.000Z'), timeZone: 'UTC' });
  });

  const expect422 = (fn: () => unknown, message: string, body: Record<string, unknown> = {}) => {
    try { fn(); } catch (e) {
      expect(e).toBeInstanceOf(LedgerError);
      expect((e as LedgerError).status).toBe(422);
      expect((e as LedgerError).message).toBe(message);
      expect((e as LedgerError).body).toEqual(body);
      return;
    }
    throw new Error('expected a 422');
  };

  it('ledger_add stores the title, trimmed; the question stays as it is', () => {
    ledger.add('s1', 'coord', { kind: 'go', text: 'Do you approve the merge of board PR #26?', ...GO_CARD, title: '  Merge board PR #26 ' });
    expect(ledgerDb.getBySeq(db, 's1', 1)).toMatchObject({ text: 'Do you approve the merge of board PR #26?', title: 'Merge board PR #26' });
  });

  it('a bad title is a 422 with the reason, and nothing is created', () => {
    expect422(() => ledger.add('s1', 'coord', { kind: 'decide', text: 'Which store?', ...DECIDE_CARD, title: 'Store' }), TITLE_TWO_WORDS_ERROR);
    expect422(() => ledger.add('s1', 'coord', { kind: 'do', text: 'Check staging.', title: 'N41 Q12' }), TITLE_CODE_ONLY_ERROR);
    expect422(() => ledger.importItems('s1', 'coord', [
      { kind: 'do', text: 'Check staging.', title: 'Check staging' },
      { kind: 'do', text: 'Rotate the key.', title: 'Rotate\nthe key' },
    ]), TITLE_ONE_LINE_ERROR, { item: 1 });
    expect(ledgerDb.listBySession(db, 's1')).toEqual([]);
  });

  it('ledger_import stores a title per item', () => {
    ledger.importItems('s1', 'coord', [{ kind: 'do', text: 'Check the banner on staging.', title: 'Check the staging banner' }]);
    expect(ledgerDb.getBySeq(db, 's1', 1)!.title).toBe('Check the staging banner');
  });
});

// Unit 2: the tools. The title is required on each new go, decide and do item.
describe('the title in the tools', () => {
  let db: Database.Database;
  let ledger: LedgerService;
  let changes: string[];
  const T = '2026-10-09T10:00:00.000Z';
  let clockAt = T;
  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
    sessionsDb.create(db, { id: 's2', provider: 'claude-code', name: 'q', workingDir: '/tmp' });
    terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
    terminalsDb.create(db, { id: 'coord2', sessionId: 's2', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
    terminalsDb.create(db, { id: 'agent', sessionId: 's1', type: 'claude-code', label: 'Readiness planner', config: { role: 'agent' } });
    changes = [];
    clockAt = T;
    ledger = new LedgerService(db, { clock: () => Date.parse(clockAt), timeZone: 'UTC', onChange: (id) => changes.push(id) });
  });

  const status = (fn: () => unknown): { status: number; message: string; body: Record<string, unknown> } => {
    try { fn(); } catch (e) {
      if (e instanceof LedgerError) return { status: e.status, message: e.message, body: e.body };
      throw e;
    }
    throw new Error('expected a LedgerError');
  };

  it('the fixed text for a missing title', () => {
    expect(TITLE_MISSING_ERROR).toBe(
      'A go, decide or do item needs a title: a short label of at least 2 words and at most 50 characters (about 40 is best). Add it and try again.');
  });

  it('ledger_add: required for go, decide and do; nothing is created without it', () => {
    for (const input of [
      { kind: 'go', text: 'Merge board PR #26?', ...GO_CARD, title: undefined },
      { kind: 'decide', text: 'Which store goes first?', ...DECIDE_CARD, title: undefined },
      { kind: 'do', text: 'Check the banner on staging.' },
      { kind: 'do', text: 'Check the banner on staging.', title: '   ' },
    ]) {
      expect(status(() => ledger.add('s1', 'coord', input)), input.kind).toEqual({ status: 422, message: TITLE_MISSING_ERROR, body: {} });
    }
    expect(ledgerDb.listBySession(db, 's1')).toEqual([]);
  });

  it('ledger_import: required for an open go, decide or do item; optional for answered and parked items and for statements', () => {
    expect(status(() => ledger.importItems('s1', 'coord', [
      { kind: 'do', text: 'Check staging.', title: 'Check staging' },
      { kind: 'go', text: 'Merge board PR #26?', ...GO_CARD, title: undefined },
    ]))).toEqual({ status: 422, message: TITLE_MISSING_ERROR, body: { item: 1 } });
    expect(ledgerDb.listBySession(db, 's1')).toEqual([]);
    const out = ledger.importItems('s1', 'coord', [
      { kind: 'decide', text: 'Use library A?', status: 'answered', ...DECIDE_CARD, title: undefined },
      { kind: 'do', text: 'Rename the CLI.', status: 'parked' },
      { kind: 'statement', text: 'never deploy on Fridays' },
      { kind: 'statement', text: 'always ask before a release', title: 'Ask before a release' },
    ]);
    expect(out.ids).toEqual(['N1', 'N2', 'N3', 'N4']);
    expect(ledgerDb.listBySession(db, 's1').map((i) => i.title)).toEqual([null, null, null, 'Ask before a release']);
  });

  it('ledger_add_from_agent: required; the agent\'s text stays word for word', () => {
    ledger.captureAgentBlock('s1', { id: 'agent', label: 'Readiness planner', mission: null }, [{
      id: 'LR-6', kind: 'decide', question: 'How many clean nights before live mode?', ...DECIDE_CARD, title: undefined, source: undefined,
      where: { path: 'docs/plans/readiness.md', section: 'Owner decisions' },
    }]);
    expect(status(() => ledger.addFromAgent('s1', 'coord', { id: 'N1' }))).toEqual({ status: 422, message: TITLE_MISSING_ERROR, body: {} });
    expect(ledgerDb.getBySeq(db, 's1', 1)!.status).toBe('proposed');
    expect(status(() => ledger.addFromAgent('s1', 'coord', { id: 'N1', title: 'Nights' })).message).toBe(TITLE_TWO_WORDS_ERROR);
    expect(ledger.addFromAgent('s1', 'coord', { id: 'N1', title: 'Clean nights before live mode' })).toEqual({ id: 'N1', status: 'open' });
    expect(ledgerDb.getBySeq(db, 's1', 1)).toMatchObject({
      status: 'open', text: 'How many clean nights before live mode?', title: 'Clean nights before live mode',
    });
  });

  it('ledger_decide_self and ledger_note need no title', () => {
    const own = { text: 'Which retry helper?', ...DECIDE_CARD, title: undefined, choice: 'A. 5 nights', reason: 'it covers this case' };
    expect(ledger.decideSelf('s1', 'coord', own).id).toBe('N1');
    expect(ledgerDb.getBySeq(db, 's1', 1)!.title).toBeNull();
  });

  it('ledger_set_title sets and changes the title of an item of the own project; the question and the update time stay', () => {
    ledger.add('s1', 'coord', { kind: 'go', text: 'Do you approve the merge of board PR #26?', ...GO_CARD, title: 'Merge PR #26' });
    changes.length = 0;
    clockAt = '2026-10-09T11:00:00.000Z'; // review round 1: a later clock, so a changed updated_at would show
    expect(ledger.setTitle('s1', 'coord', { id: 'N1', title: 'Merge board PR #26' })).toEqual({ id: 'N1', title: 'Merge board PR #26' });
    expect(ledgerDb.getBySeq(db, 's1', 1)).toMatchObject({
      text: 'Do you approve the merge of board PR #26?', title: 'Merge board PR #26', updatedAt: T,
    });
    expect(changes).toEqual(['s1']);
  });

  it('a new title on an answered item that a recap already showed does not bring it back into "Decided"', () => {
    terminalsDb.updateConfig(db, 'coord', { role: 'coordinator', lastRecapAt: '2026-10-09T10:30:00.000Z' });
    ledgerDb.create(db, { sessionId: 's1', kind: 'go', text: 'Merge PR #12?', title: 'Merge PR #12', author: 'overseer', status: 'answered', now: T });
    clockAt = '2026-10-09T11:00:00.000Z';
    ledger.setTitle('s1', 'coord', { id: 'N1', title: 'Merge the fix PR #12' });
    expect(ledger.list('s1', 'coord').paste).not.toContain('Decided');
  });

  it('ledger_set_title: a label, so a closed item and a statement take one too', () => {
    ledger.importItems('s1', 'coord', [{ kind: 'statement', text: 'never deploy on Fridays' }]);
    expect(ledger.setTitle('s1', 'coord', { id: 'N1', title: 'No Friday deploys' }).title).toBe('No Friday deploys');
  });

  it('ledger_set_title: overseer only, own project only; a bad or missing title is refused and changes nothing', () => {
    ledger.add('s1', 'coord', { kind: 'do', text: 'Check the banner on staging.', title: 'Check the staging banner' });
    for (const caller of ['agent', 'coord2', undefined]) {
      expect(status(() => ledger.setTitle('s1', caller, { id: 'N1', title: 'Check the banner' })).status).toBe(403);
    }
    expect(status(() => ledger.setTitle('s2', 'coord2', { id: 'N1', title: 'Check the banner' }))).toMatchObject({ status: 404, message: 'Unknown ledger item: N1' });
    expect(status(() => ledger.setTitle('s1', 'coord', { id: 'N1', title: 'Banner' }))).toMatchObject({ status: 422, message: TITLE_TWO_WORDS_ERROR });
    expect(status(() => ledger.setTitle('s1', 'coord', { id: 'N1' }))).toMatchObject({ status: 400, message: 'title is required' });
    expect(status(() => ledger.setTitle('s1', 'coord', { id: 'x', title: 'Check the banner' })).status).toBe(400);
    expect(ledgerDb.getBySeq(db, 's1', 1)!.title).toBe('Check the staging banner');
  });
});
