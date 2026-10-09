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
  TITLE_MAX, TITLE_CODE_ONLY_ERROR, TITLE_ONE_LINE_ERROR, TITLE_TWO_WORDS_ERROR, titleProblem, titleTooLongError,
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
    ledger.add('s1', 'coord', { kind: 'go', text: 'Do you approve the merge of board PR #26?', title: '  Merge board PR #26 ', ...GO_CARD });
    expect(ledgerDb.getBySeq(db, 's1', 1)).toMatchObject({ text: 'Do you approve the merge of board PR #26?', title: 'Merge board PR #26' });
  });

  it('a bad title is a 422 with the reason, and nothing is created', () => {
    expect422(() => ledger.add('s1', 'coord', { kind: 'decide', text: 'Which store?', title: 'Store', ...DECIDE_CARD }), TITLE_TWO_WORDS_ERROR);
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
