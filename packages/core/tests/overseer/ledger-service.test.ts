import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as ledgerDb from '../../src/db/ledger.js';
import * as messagesDb from '../../src/db/coordinator-messages.js';
import { LedgerService, LedgerError, NOT_OVERSEER_ERROR, parseLedgerId, quoteNotFoundAfterError, QUOTE_NOT_FOUND_STATEMENT_ERROR } from '../../src/overseer/ledger-service.js';
import { OK_ONLY_ERROR } from '../../src/overseer/ledger-quote.js';

const T0 = Date.parse('2026-10-05T16:00:00.000Z');
const min = (n: number) => new Date(T0 + n * 60_000).toISOString();

let db: Database.Database;
let now: number;
let ledger: LedgerService;

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
  sessionsDb.create(db, { id: 's2', provider: 'claude-code', name: 'q', workingDir: '/tmp' });
  terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator', transport: 'structured' } });
  terminalsDb.create(db, { id: 'agent', sessionId: 's1', type: 'claude-code', label: 'worker', config: { role: 'agent' } });
  terminalsDb.create(db, { id: 'plain', sessionId: 's1', type: 'claude-code', label: 'plain', config: {} });
  terminalsDb.create(db, { id: 'coord2', sessionId: 's2', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
  now = T0;
  ledger = new LedgerService(db, { clock: () => now, timeZone: 'UTC' });
});

const userSays = (text: string, minute: number, source: messagesDb.CoordinatorMessageSource = 'user') =>
  messagesDb.append(db, { terminalId: 'coord', source, text, sentAt: min(minute) });

function expectLedgerError(fn: () => unknown, status: number, message?: string): LedgerError {
  try { fn(); } catch (e) {
    expect(e).toBeInstanceOf(LedgerError);
    expect((e as LedgerError).status).toBe(status);
    if (message !== undefined) expect((e as LedgerError).message).toBe(message);
    return e as LedgerError;
  }
  throw new Error('expected a LedgerError');
}

describe('parseLedgerId', () => {
  it('accepts N12, n12, 12 and 12 as a number', () => {
    expect(parseLedgerId('N12')).toBe(12);
    expect(parseLedgerId('n12')).toBe(12);
    expect(parseLedgerId(' 12 ')).toBe(12);
    expect(parseLedgerId(12)).toBe(12);
    expect(parseLedgerId('N0')).toBeNull();
    expect(parseLedgerId('twelve')).toBeNull();
  });
});

describe('overseer-only check', () => {
  it('rejects an agent, a plain thread, another project\'s overseer, an archived overseer, and no caller', () => {
    terminalsDb.create(db, { id: 'old', sessionId: 's1', type: 'claude-code', label: 'old', config: { role: 'coordinator' } });
    terminalsDb.archive(db, 'old');
    for (const caller of ['agent', 'plain', 'coord2', 'old', undefined, 'nope']) {
      expectLedgerError(() => ledger.add('s1', caller, { kind: 'go', text: 'Merge PR #12.' }), 403, NOT_OVERSEER_ERROR);
    }
    expect(ledgerDb.listBySession(db, 's1')).toEqual([]);
  });
});

describe('add', () => {
  it('creates an open item and returns its ID and rendered line', () => {
    expect(ledger.add('s1', 'coord', { kind: 'decide', text: 'Which store goes first?', options: ['A', 'B'] })).toEqual({
      id: 'N1',
      line: 'N1 [Decide] Which store goes first? (open 0m)\n  Options: A | B\n  Proposed by overseer, not approved',
    });
  });

  it('supersedes: the old open item becomes superseded; the new line shows the original question', () => {
    ledger.add('s1', 'coord', { kind: 'decide', text: 'Use library A?' });
    ledger.add('s1', 'coord', { kind: 'go', text: 'Merge PR #12.' });
    ledger.add('s1', 'coord', { kind: 'decide', text: 'Set the first store to Draft?' });
    const out = ledger.add('s1', 'coord', { kind: 'decide', text: 'Also set the second store to Draft?', supersedes: 'N3' });
    expect(out).toEqual({
      id: 'N4',
      line: 'N4 [Decide] Also set the second store to Draft? (open 0m)\n' +
        '  Original question (N3): "Set the first store to Draft?"\n' +
        '  Proposed by overseer, not approved',
    });
    expect(ledgerDb.getBySeq(db, 's1', 3)!.status).toBe('superseded');
    expect(ledgerDb.listOpenSeqs(db, 's1')).toEqual([1, 2, 4]);
  });

  it('rejects a bad kind, missing text, and an unknown supersedes ID', () => {
    expectLedgerError(() => ledger.add('s1', 'coord', { kind: 'statement', text: 'x' }), 400);
    expectLedgerError(() => ledger.add('s1', 'coord', { kind: 'go', text: '  ' }), 400);
    expectLedgerError(() => ledger.add('s1', 'coord', { kind: 'go', text: 'x', supersedes: 'N9' }), 404, 'Unknown ledger item: N9');
  });
});

describe('resolve', () => {
  beforeEach(() => { ledger.add('s1', 'coord', { kind: 'decide', text: 'Which store goes first?' }); });

  it('answered: finds the quote in a later user message and stores the user\'s words and message link', () => {
    const msgId = userSays('N1: A, but only for the first store', 5);
    now = T0 + 6 * 60_000;
    const out = ledger.resolve('s1', 'coord', { id: 'N1', status: 'answered', quote: 'a, but only for the FIRST store' });
    expect(out.line).toContain('You approved: "Which store goes first?" → "A, but only for the first store" (Mon 16:05)');
    expect(ledgerDb.getBySeq(db, 's1', 1)).toMatchObject({ status: 'answered', quote: 'A, but only for the first store', quoteMessageId: msgId, quoteAt: min(5) });
  });

  it('a quote that is not in the user\'s messages fails with the fixed text and changes nothing', () => {
    userSays('B', 5);
    userSays('A', 6, 'canned');
    userSays('A', 7, 'daemon');
    expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N1', status: 'answered', quote: 'A' }), 422,
      "Quote not found in the user's messages to you after N1 was created. Do not record it. Ask the user.");
    expect(quoteNotFoundAfterError(1)).toBe("Quote not found in the user's messages to you after N1 was created. Do not record it. Ask the user.");
    expect(ledgerDb.getBySeq(db, 's1', 1)!.status).toBe('open');
  });

  it('a message sent before the item was created never counts', () => {
    messagesDb.append(db, { terminalId: 'coord', source: 'user', text: 'A', sentAt: min(-1) });
    expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N1', status: 'answered', quote: 'A' }), 422);
  });

  it('an "ok"-only answer fails with the ok text', () => {
    userSays('ok', 5);
    expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N1', status: 'answered', quote: 'ok' }), 422, OK_ONLY_ERROR);
  });

  it('parked needs a quote too; withdrawn needs a reason and no quote', () => {
    expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N1', status: 'parked' }), 400);
    expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N1', status: 'withdrawn' }), 400);
    const out = ledger.resolve('s1', 'coord', { id: 'N1', status: 'withdrawn', reason: 'the agent found a built-in option' });
    expect(out.line).toBe('N1 [Decide] Which store goes first?\n  Withdrawn by overseer: the agent found a built-in option');
  });

  it('a closed item returns 409 with its current status; an unknown ID returns 404', () => {
    ledger.resolve('s1', 'coord', { id: 'N1', status: 'withdrawn', reason: 'moot' });
    const e = expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N1', status: 'withdrawn', reason: 'again' }), 409, 'N1 is already withdrawn.');
    expect(e.body).toEqual({ status: 'withdrawn' });
    expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N7', status: 'withdrawn', reason: 'x' }), 404, 'Unknown ledger item: N7');
  });
});

describe('note', () => {
  it('creates a statement from a checked quote, with an optional reading', () => {
    userSays('never touch the archive table, ok?', 1);
    const out = ledger.note('s1', 'coord', { quote: 'never touch the archive table', reading: 'no agent writes to archive_* tables' });
    expect(out).toEqual({ id: 'N1', line: 'N1 You said: "never touch the archive table" (Mon 16:01)\n  I read this as: no agent writes to archive_* tables' });
    expect(ledgerDb.getBySeq(db, 's1', 1)).toMatchObject({ kind: 'statement', author: 'you', status: 'answered' });
  });

  it('fails for words the user did not write, and for an ok-only quote', () => {
    userSays('ok', 1);
    expectLedgerError(() => ledger.note('s1', 'coord', { quote: 'always deploy on Fridays' }), 422, QUOTE_NOT_FOUND_STATEMENT_ERROR);
    expectLedgerError(() => ledger.note('s1', 'coord', { quote: 'ok' }), 422, OK_ONLY_ERROR);
  });
});

describe('list', () => {
  it('renders the sections; forRecap stamps lastRecapAt and clears interimDueAt', () => {
    terminalsDb.updateConfig(db, 'coord', { role: 'coordinator', transport: 'structured', interimDueAt: min(20) });
    ledger.add('s1', 'coord', { kind: 'go', text: 'Merge PR #12.' });
    const plain = ledger.list('s1', 'coord');
    expect(plain.text).toContain('Needs you now:\n- N1 [Go] Merge PR #12. (open 0m)');
    expect(plain.openIds).toEqual(['N1']);
    expect(JSON.parse(terminalsDb.getById(db, 'coord')!.config!).interimDueAt).toBe(min(20)); // a plain list changes nothing

    now = T0 + 30 * 60_000;
    ledger.list('s1', 'coord', { forRecap: true });
    const cfg = JSON.parse(terminalsDb.getById(db, 'coord')!.config!);
    expect(cfg.lastRecapAt).toBe(min(30));
    expect(cfg.interimDueAt).toBeUndefined();
    expect(cfg.role).toBe('coordinator'); // the rest of the config survives
  });
});

describe('import', () => {
  it('loads items as imported; an unchecked imported decision can be confirmed with a quote', () => {
    const out = ledger.importItems('s1', 'coord', [
      { kind: 'go', text: 'Merge PR #9.' },
      { kind: 'decide', text: 'Use library A?', status: 'answered' },
      { kind: 'statement', text: 'keep prices as they are' },
    ]);
    expect(out).toEqual({ ids: ['N1', 'N2', 'N3'] });
    expect(ledgerDb.listBySession(db, 's1').map((i) => [i.origin, i.status, i.author])).toEqual([
      ['imported', 'open', 'overseer'], ['imported', 'answered', 'overseer'], ['imported', 'answered', 'you'],
    ]);
    expect(ledger.list('s1', 'coord').text).toContain('- N2 [Decide] Use library A?\n  Imported, not checked');

    userSays('yes, library A', 2);
    const confirmed = ledger.resolve('s1', 'coord', { id: 'N2', status: 'answered', quote: 'library A' });
    expect(confirmed.line).toContain('You approved: "Use library A?" → "library A"');
    expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N2', status: 'answered', quote: 'library A' }), 409);
  });

  it('a withdrawn imported item is closed: it cannot be resolved again, and it renders the withdrawal', () => {
    ledger.importItems('s1', 'coord', [{ kind: 'decide', text: 'Use library A?', status: 'answered' }]);
    const out = ledger.resolve('s1', 'coord', { id: 'N1', status: 'withdrawn', reason: 'the import was wrong' });
    expect(out.line).toBe('N1 [Decide] Use library A?\n  Withdrawn by overseer: the import was wrong\n  Imported, not checked');
    userSays('library A', 2);
    for (const status of ['answered', 'parked']) {
      const e = expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N1', status, quote: 'library A' }), 409, 'N1 is already withdrawn.');
      expect(e.body).toEqual({ status: 'withdrawn' });
    }
    expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N1', status: 'withdrawn', reason: 'again' }), 409);
    expect(ledgerDb.getBySeq(db, 's1', 1)).toMatchObject({ status: 'withdrawn', reason: 'the import was wrong', quote: null });
  });

  it('a superseded imported item is closed', () => {
    ledger.importItems('s1', 'coord', [{ kind: 'decide', text: 'Set the first store to Draft?' }]);
    ledger.add('s1', 'coord', { kind: 'decide', text: 'Also set the second store to Draft?', supersedes: 'N1' });
    expect(ledgerDb.getBySeq(db, 's1', 1)!.status).toBe('superseded');
    userSays('yes, the first store', 2);
    expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N1', status: 'answered', quote: 'the first store' }), 409, 'N1 is already superseded.');
    expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N1', status: 'withdrawn', reason: 'moot' }), 409, 'N1 is already superseded.');
  });

  it('an unchecked imported parked item can still be confirmed once', () => {
    ledger.importItems('s1', 'coord', [{ kind: 'decide', text: 'Rename the CLI?', status: 'parked' }]);
    userSays('park the rename', 2);
    expect(ledger.resolve('s1', 'coord', { id: 'N1', status: 'parked', quote: 'park the rename' }).status).toBe('parked');
    expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N1', status: 'parked', quote: 'park the rename' }), 409);
  });

  it('rejects an empty list or a bad item, and creates nothing', () => {
    expectLedgerError(() => ledger.importItems('s1', 'coord', []), 400);
    expectLedgerError(() => ledger.importItems('s1', 'coord', [{ kind: 'go', text: 'ok' }, { kind: 'nope', text: 'x' }]), 400);
    expect(ledgerDb.listBySession(db, 's1')).toEqual([]);
  });
});

describe('handoff', () => {
  it('renders the verbatim block for the given IDs, and 404s an unknown ID', () => {
    ledger.add('s1', 'coord', { kind: 'decide', text: 'Use library A?' });
    userSays('A', 1);
    ledger.resolve('s1', 'coord', { id: 'N1', status: 'answered', quote: 'A' });
    expect(ledger.handoff('s1', 'coord', ['N1']).block).toBe(
      'Owner decisions (verbatim, from the ledger):\n- N1 [Decide] Use library A?\n  You approved: "Use library A?" → "A" (Mon 16:01)',
    );
    expectLedgerError(() => ledger.handoff('s1', 'coord', ['N1', 'N5']), 404, 'Unknown ledger item: N5');
  });
});
