// Unit 2 rule 7 (decision 5): a go item (merge, deploy, release) becomes answered only when the
// user's words name it — its ID or an action word. A bare "yes" is not enough.
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as ledgerDb from '../../src/db/ledger.js';
import * as messagesDb from '../../src/db/coordinator-messages.js';
import { GO_APPROVAL_ERROR, namesGoApproval } from '../../src/overseer/ledger-quote.js';
import { LedgerService, LedgerError, quoteNotFoundAfterError } from '../../src/overseer/ledger-service.js';

describe('namesGoApproval', () => {
  it('"yes" fails; "yes, merge it" and "N12: yes" pass; "emerged" does not count as "merge"', () => {
    expect(namesGoApproval('yes', 12)).toBe(false);
    expect(namesGoApproval('yes, merge it', 12)).toBe(true);
    expect(namesGoApproval('N12: yes', 12)).toBe(true);
    expect(namesGoApproval('emerged', 12)).toBe(false);
  });

  it('every action word counts, in any case, as a whole word only', () => {
    for (const word of ['merge', 'deploy', 'release', 'push', 'restart', 'update', 'MERGE', 'Deploy']) {
      expect(namesGoApproval(`yes, ${word}`, 12), word).toBe(true);
    }
    expect(namesGoApproval('merged it already', 12)).toBe(false);
    expect(namesGoApproval('yes to N123', 12)).toBe(false);
    expect(namesGoApproval('n12 yes', 12)).toBe(true);
  });

  it('has the fixed failure text', () => {
    expect(GO_APPROVAL_ERROR).toBe("A go item needs its ID or the action word in the user's answer. A bare yes is not enough. Ask the user.");
  });
});

describe('ledger_resolve on a go item', () => {
  const T0 = Date.parse('2026-10-05T16:00:00.000Z');
  let db: Database.Database;
  let ledger: LedgerService;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
    terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
    ledger = new LedgerService(db, { clock: () => T0, timeZone: 'UTC' });
    ledger.add('s1', 'coord', { kind: 'go', text: 'Merge PR #12.' });
  });

  const says = (text: string, minute: number) =>
    messagesDb.append(db, { terminalId: 'coord', source: 'user', text, sentAt: new Date(T0 + minute * 60_000).toISOString() });

  function status422(fn: () => unknown): string {
    try { fn(); } catch (e) { expect((e as LedgerError).status).toBe(422); return (e as LedgerError).message; }
    throw new Error('expected a 422');
  }

  it('a bare "yes" does not approve it, and the item stays open', () => {
    says('yes', 1);
    expect(status422(() => ledger.resolve('s1', 'coord', { id: 'N1', status: 'answered', quote: 'yes' }))).toBe(GO_APPROVAL_ERROR);
    expect(ledgerDb.getBySeq(db, 's1', 1)!.status).toBe('open');
  });

  it('"N1: yes" approves it', () => {
    says('N1: yes', 1);
    expect(ledger.resolve('s1', 'coord', { id: 'N1', status: 'answered', quote: 'N1: yes' }).status).toBe('answered');
  });

  it('"ok, merge it" approves it with the quote "merge it" (rule 6 first, then rule 7)', () => {
    says('ok, merge it', 1);
    ledger.resolve('s1', 'coord', { id: 'N1', status: 'answered', quote: 'ok, merge it' });
    expect(ledgerDb.getBySeq(db, 's1', 1)!.quote).toBe('merge it');
  });

  it('"N1" quoted from "N12: yes" is not found: the quote check respects word edges', () => {
    says('N12: yes', 1);
    expect(status422(() => ledger.resolve('s1', 'coord', { id: 'N1', status: 'answered', quote: 'N1' }))).toBe(quoteNotFoundAfterError(1));
    expect(ledgerDb.getBySeq(db, 's1', 1)!.status).toBe('open');
  });

  it('"merge" quoted from "the branches emerged fine" is not found', () => {
    says('the branches emerged fine', 1);
    expect(status422(() => ledger.resolve('s1', 'coord', { id: 'N1', status: 'answered', quote: 'merge' }))).toBe(quoteNotFoundAfterError(1));
    expect(ledgerDb.getBySeq(db, 's1', 1)!.status).toBe('open');
  });

  it('parking a go item needs no named approval', () => {
    says('later', 1);
    expect(ledger.resolve('s1', 'coord', { id: 'N1', status: 'parked', quote: 'later' }).status).toBe('parked');
  });

  it('a decide item still accepts a bare "yes"', () => {
    ledger.add('s1', 'coord', { kind: 'decide', text: 'Use library A?' });
    says('yes', 1);
    expect(ledger.resolve('s1', 'coord', { id: 'N2', status: 'answered', quote: 'yes' }).status).toBe('answered');
  });
});
