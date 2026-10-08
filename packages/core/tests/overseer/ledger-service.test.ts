import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as ledgerDb from '../../src/db/ledger.js';
import * as messagesDb from '../../src/db/coordinator-messages.js';
import { LedgerService, LedgerError, NOT_OVERSEER_ERROR, parseLedgerId, quoteNotFoundAfterError, QUOTE_NOT_FOUND_STATEMENT_ERROR } from '../../src/overseer/ledger-service.js';
import { OK_ONLY_ERROR } from '../../src/overseer/ledger-quote.js';
import { renderCard } from '../../src/overseer/ledger-render.js';
import { DECIDE_CARD, GO_CARD, LR6 } from './card-fixtures.js';
import { ONLY_USER_ERROR } from '../../src/overseer/ledger-checks.js';

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
      expectLedgerError(() => ledger.add('s1', caller, { kind: 'go', text: 'Merge PR #12.', ...GO_CARD }), 403, NOT_OVERSEER_ERROR);
    }
    expect(ledgerDb.listBySession(db, 's1')).toEqual([]);
  });
});

describe('add', () => {
  it('creates an open item with every card field and returns its ID and its one line', () => {
    const out = ledger.add('s1', 'coord', { kind: 'decide', text: 'How many clean nights before live mode?', ...DECIDE_CARD, note: 'Check the dates.', blocks: 'the switch to live mode' });
    expect(out.id).toBe('N1');
    // Pinned card spec 2026-10-08, Unit 5: the chat gets one line; the full card is on the pinned card.
    expect(out.line).toBe('N1 · Decide · How many clean nights before live mode? — the full card is on the pinned card.');
    // ledger_show still renders the full card for the chat.
    expect(ledger.show('s1', 'coord', { ids: ['N1'] }).text).toBe(renderCard(ledgerDb.getBySeq(db, 's1', 1)!, { now, timeZone: 'UTC' }));
    expect(ledgerDb.getBySeq(db, 's1', 1)).toMatchObject({
      status: 'open', context: DECIDE_CARD.context, options: DECIDE_CARD.options, recommendation: 'A. 5 nights',
      recommendationWhy: DECIDE_CARD.why, defaultText: DECIDE_CARD.default, sourceKind: 'overseer', sourceRef: null,
      overseerNote: 'Check the dates.', sentAt: min(0),
    });
  });

  it('supersedes: the old open item becomes superseded; the new card shows the original question', () => {
    ledger.add('s1', 'coord', { kind: 'decide', text: 'Use library A?', ...DECIDE_CARD });
    ledger.add('s1', 'coord', { kind: 'go', text: 'Merge PR #12.', ...GO_CARD });
    ledger.add('s1', 'coord', { kind: 'decide', text: 'Set the first store to Draft?', ...DECIDE_CARD });
    const out = ledger.add('s1', 'coord', { kind: 'decide', text: 'Also set the second store to Draft?', ...DECIDE_CARD, supersedes: 'N3' });
    expect(out.id).toBe('N4');
    expect(out.line).toBe('N4 · Decide · Also set the second store to Draft? — the full card is on the pinned card.');
    expect(ledger.show('s1', 'coord', { ids: ['N4'] }).text).toContain('\n\n**Original question (N3):** "Set the first store to Draft?"\n\n');
    expect(ledgerDb.getBySeq(db, 's1', 3)!.status).toBe('superseded');
    expect(ledgerDb.listOpenSeqs(db, 's1')).toEqual([1, 2, 4]);
  });

  it('rejects a bad kind, missing text, and an unknown supersedes ID', () => {
    expectLedgerError(() => ledger.add('s1', 'coord', { kind: 'statement', text: 'x' }), 400);
    expectLedgerError(() => ledger.add('s1', 'coord', { kind: 'go', text: '  ', ...GO_CARD }), 400);
    expectLedgerError(() => ledger.add('s1', 'coord', { kind: 'go', text: 'x', ...GO_CARD, supersedes: 'N9' }), 404, 'Unknown ledger item: N9');
  });
});

describe('card checks (decision cards, Unit 2)', () => {
  let project: string;
  let worktree: string;
  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-proj-'));
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-wt-'));
    fs.mkdirSync(path.join(project, 'docs/plans'), { recursive: true });
    fs.writeFileSync(path.join(project, 'docs/plans/readiness.md'), '# plan');
    fs.mkdirSync(path.join(worktree, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'docs/branch-only.md'), '# only on the branch');
    sessionsDb.create(db, { id: 'p', provider: 'claude-code', name: 'proj', workingDir: project });
    terminalsDb.create(db, { id: 'pcoord', sessionId: 'p', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
    terminalsDb.create(db, { id: 'planner-1', sessionId: 'p', type: 'claude-code', label: 'Readiness planner', config: { role: 'agent', agentType: 'planner' } });
    terminalsDb.create(db, { id: 'pplain', sessionId: 'p', type: 'claude-code', label: 'Scratch', config: {} });
    ledger = new LedgerService(db, { clock: () => now, timeZone: 'UTC', listWorktrees: (dir) => (dir === project ? [project, worktree] : []) });
  });
  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  const addP = (extra: Record<string, unknown>, kind = 'decide') =>
    ledger.add('p', 'pcoord', { kind, text: 'How many clean nights before live mode?', ...(kind === 'go' ? GO_CARD : DECIDE_CARD), ...extra });

  it('rule 1: a decide or go item without the card fields fails with the fixed text and creates nothing', () => {
    expectLedgerError(() => ledger.add('p', 'pcoord', { kind: 'decide', text: 'Which helper?' }), 422,
      'A decision card needs: context (20 to 800 characters), options (at least 2, each { label, effect }), default, source. Add them and try again.');
    expectLedgerError(() => ledger.add('p', 'pcoord', { kind: 'go', text: 'Merge PR #12.' }), 422,
      'A decision card needs: context (20 to 800 characters), default, source. Add them and try again.');
    expectLedgerError(() => addP({ why: '' }), 422, 'A decision card needs: why. Add them and try again.');
    expect(ledgerDb.listBySession(db, 'p')).toEqual([]);
  });

  it('rule 1: malformed go options are a 422 with the card text, not a 400', () => {
    for (const options of ['bad', { label: 'merge', effect: 'ships' }]) {
      expectLedgerError(() => addP({ options }, 'go'), 422, 'A decision card needs: options (each { label, effect }). Add them and try again.');
      expectLedgerError(() => ledger.importItems('p', 'pcoord', [{ kind: 'go', text: 'Merge it?', ...GO_CARD, options }]), 422,
        'A decision card needs: options (each { label, effect }). Add them and try again.');
    }
    expect(ledgerDb.listBySession(db, 'p')).toEqual([]);
  });

  it('rule 1: a do item needs no card fields', () => {
    expect(ledger.add('p', 'pcoord', { kind: 'do', text: 'Check the banner on staging.' }).id).toBe('N1');
  });

  it('rule 2: a range or 3+ plan IDs in the question fails; a single LR-6 passes', () => {
    for (const text of ['Approve LR-1..LR-26?', 'Accept D1 to D9?', 'Keep D2-D6?', 'Answer Q1–Q6?', 'Keep LR-12, LR-14 and LR-20?']) {
      expectLedgerError(() => addP({ text }), 422, 'One decision per card. Add each decision on its own.');
    }
    expect(addP({ text: 'LR-6: how many clean nights before live mode?' }).id).toBe('N1');
  });

  it('rule 3: plan and doc paths must exist inside the project or one of its worktrees', () => {
    expect(addP({ source: { kind: 'plan', ref: 'docs/plans/readiness.md', section: 'Owner decisions', id: 'LR-6' } }).id).toBe('N1');
    expect(ledgerDb.getBySeq(db, 'p', 1)).toMatchObject({ sourceKind: 'plan', sourceRef: 'docs/plans/readiness.md', sourceSection: 'Owner decisions', sourceId: 'LR-6' });
    expect(addP({ source: { kind: 'doc', ref: 'docs/branch-only.md' } }).id).toBe('N2'); // only in the worktree
    expectLedgerError(() => addP({ source: { kind: 'plan', ref: 'docs/plans/missing.md' } }), 422,
      'The source does not exist in this project: docs/plans/missing.md.');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'x.md'), 'x');
      const escape = path.relative(project, path.join(outside, 'x.md'));
      expectLedgerError(() => addP({ source: { kind: 'doc', ref: escape } }), 422, `The source does not exist in this project: ${escape}.`);
      expectLedgerError(() => addP({ source: { kind: 'doc', ref: path.join(outside, 'x.md') } }), 422);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });

  it('rule 3: an absolute plan or doc path fails, even inside the project', () => {
    const inside = path.join(project, 'docs/plans/readiness.md');
    for (const kind of ['plan', 'doc']) {
      expectLedgerError(() => addP({ source: { kind, ref: inside } }), 422, `The source does not exist in this project: ${inside}.`);
    }
    expect(ledgerDb.listBySession(db, 'p')).toEqual([]);
  });

  it('rule 3: an agent source is an agent thread of this project, by label or ID; the item stores its label', () => {
    expect(addP({ source: { kind: 'agent', ref: 'Readiness planner' } }).id).toBe('N1');
    expect(addP({ source: { kind: 'agent', ref: 'planner-1' } }).id).toBe('N2');
    expect(ledgerDb.getBySeq(db, 'p', 2)!.sourceRef).toBe('Readiness planner');
    terminalsDb.archive(db, 'planner-1'); // an archived agent still existed
    expect(addP({ source: { kind: 'agent', ref: 'Readiness planner' } }).id).toBe('N3');
    expectLedgerError(() => addP({ source: { kind: 'agent', ref: 'Scratch' } }), 422, 'The source does not exist in this project: Scratch.');
    expectLedgerError(() => addP({ source: { kind: 'agent', ref: 'worker' } }), 422); // an agent of another project
  });

  // Overseer memory scope (spec 2026-10-07), Unit 4: `thread` is one of the user's own threads;
  // `agent` is an agent only.
  it('a thread source is a thread of this project that is neither an agent nor the overseer, by label or ID; the item stores its label and renders it', () => {
    const first = addP({ source: { kind: 'thread', ref: 'Scratch' } });
    expect(first.id).toBe('N1');
    expect(ledger.show('p', 'pcoord', { ids: ['N1'] }).text).toContain(' · Source: your thread "Scratch"');
    expect(addP({ source: { kind: 'thread', ref: 'pplain' } }).id).toBe('N2');
    expect(ledgerDb.getBySeq(db, 'p', 2)).toMatchObject({ sourceKind: 'thread', sourceRef: 'Scratch' });
    terminalsDb.archive(db, 'pplain'); // an archived thread still existed
    expect(addP({ source: { kind: 'thread', ref: 'Scratch' } }).id).toBe('N3');
  });

  it("a thread source refuses another project's thread, an agent and the overseer", () => {
    for (const ref of ['plain', 'Readiness planner', 'planner-1', 'Control Plane', 'pcoord']) {
      expectLedgerError(() => addP({ source: { kind: 'thread', ref } }), 422, `The source does not exist in this project: ${ref}.`);
    }
    expect(ledgerDb.listBySession(db, 'p')).toEqual([]);
  });

  it("an agent source refuses one of the user's own threads, by label or ID", () => {
    for (const ref of ['Scratch', 'pplain']) {
      expectLedgerError(() => addP({ source: { kind: 'agent', ref } }), 422, `The source does not exist in this project: ${ref}.`);
    }
  });

  it('rule 3: a PR or issue source has the form #123', () => {
    expect(addP({ source: { kind: 'pr', ref: '#62' } }).id).toBe('N1');
    expect(addP({ source: { kind: 'issue', ref: '#7' } }).id).toBe('N2');
    expectLedgerError(() => addP({ source: { kind: 'pr', ref: '62' } }), 422, 'The source does not exist in this project: 62.');
  });

  it('rule 3: a user source needs a checked quote (as in #62); overseer is always allowed', () => {
    messagesDb.append(db, { terminalId: 'pcoord', source: 'user', text: 'we should switch to live mode soon', sentAt: min(-5) });
    messagesDb.append(db, { terminalId: 'pcoord', source: 'user', text: 'ok', sentAt: min(-4) });
    expect(addP({ source: { kind: 'user', ref: 'switch to LIVE mode soon' } }).id).toBe('N1');
    expect(ledgerDb.getBySeq(db, 'p', 1)!.sourceRef).toBe('switch to live mode soon');
    expectLedgerError(() => addP({ source: { kind: 'user', ref: 'never go live' } }), 422, QUOTE_NOT_FOUND_STATEMENT_ERROR);
    expectLedgerError(() => addP({ source: { kind: 'user', ref: 'ok' } }), 422, OK_ONLY_ERROR);
    expect(addP({ source: { kind: 'overseer' } }).id).toBe('N2');
  });

  it('import applies the same checks: the failed item is named in the body and nothing is created', () => {
    const e = expectLedgerError(() => ledger.importItems('p', 'pcoord', [
      { kind: 'do', text: 'Check staging.' },
      { kind: 'decide', text: 'Use library A?' },
    ]), 422, 'A decision card needs: context (20 to 800 characters), options (at least 2, each { label, effect }), default, source. Add them and try again.');
    expect(e.body).toEqual({ item: 1 });
    expectLedgerError(() => ledger.importItems('p', 'pcoord', [{ kind: 'decide', text: 'Accept D1 to D9?', ...DECIDE_CARD }]), 422, 'One decision per card. Add each decision on its own.');
    expectLedgerError(() => ledger.importItems('p', 'pcoord', [{ kind: 'go', text: 'Merge it?', ...GO_CARD, source: { kind: 'plan', ref: 'nope.md' } }]), 422,
      'The source does not exist in this project: nope.md.');
    expect(ledgerDb.listBySession(db, 'p')).toEqual([]);
    expect(ledger.importItems('p', 'pcoord', [{ kind: 'decide', text: 'Use library A?', ...DECIDE_CARD, source: { kind: 'plan', ref: 'docs/plans/readiness.md' } }]).ids).toEqual(['N1']);
    expect(ledgerDb.getBySeq(db, 'p', 1)).toMatchObject({ origin: 'imported', context: DECIDE_CARD.context, sourceKind: 'plan' });
  });

  it('rule 5: a project rule needs the user\'s checked words; import cannot create one', () => {
    messagesDb.append(db, { terminalId: 'pcoord', source: 'user', text: 'never deploy on Fridays', sentAt: min(1) });
    messagesDb.append(db, { terminalId: 'pcoord', source: 'user', text: 'ok', sentAt: min(2) });
    const out = ledger.note('p', 'pcoord', { quote: 'never deploy on Fridays', policy: true });
    expect(ledgerDb.getBySeq(db, 'p', 1)).toMatchObject({ kind: 'statement', policy: true, quote: 'never deploy on Fridays' });
    expect(out.id).toBe('N1');
    expectLedgerError(() => ledger.note('p', 'pcoord', { quote: 'always deploy on Fridays', policy: true }), 422, QUOTE_NOT_FOUND_STATEMENT_ERROR);
    expectLedgerError(() => ledger.note('p', 'pcoord', { quote: 'ok', policy: true }), 422, OK_ONLY_ERROR);
    expect(ledger.note('p', 'pcoord', { quote: 'never deploy on Fridays' }).id).toBe('N2');
    expect(ledgerDb.getBySeq(db, 'p', 2)!.policy).toBe(false);
    expectLedgerError(() => ledger.importItems('p', 'pcoord', [{ kind: 'statement', text: 'never on Fridays', policy: true }]), 400);
  });
});

describe('resolve', () => {
  beforeEach(() => { ledger.add('s1', 'coord', { kind: 'decide', text: 'Which store goes first?', ...DECIDE_CARD }); });

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
    expect(out.line).toBe('N1 [Decide] Which store goes first?\n  Recommendation: A. 5 nights\n  Options: A. 5 nights | B. 10 nights\n  Withdrawn by overseer: the agent found a built-in option');
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
    ledger.add('s1', 'coord', { kind: 'go', text: 'Merge PR #12.', ...GO_CARD });
    const plain = ledger.list('s1', 'coord');
    expect(plain.text).toContain('Needs you now:\n\n**N1 · Go:** Merge PR #12.\n\nHolds up: nothing · Open 0 minutes · Source: overseer');
    expect(plain.openIds).toEqual(['N1']);
    expect(JSON.parse(terminalsDb.getById(db, 'coord')!.config!).interimDueAt).toBe(min(20)); // a plain list changes nothing

    now = T0 + 30 * 60_000;
    ledger.list('s1', 'coord', { forRecap: true });
    const cfg = JSON.parse(terminalsDb.getById(db, 'coord')!.config!);
    expect(cfg.lastRecapAt).toBe(min(30));
    expect(cfg.interimDueAt).toBeUndefined();
    expect(cfg.role).toBe('coordinator'); // the rest of the config survives
  });

  // Pinned card spec 2026-10-08, Unit 5: the paste block is news since the last recap.
  it('paste: the new items, the decided items and the count line, relative to the last recap', () => {
    ledger.add('s1', 'coord', { kind: 'go', text: 'Merge PR #12?', ...GO_CARD });
    expect(ledger.list('s1', 'coord').paste).toBe('New:\n- N1 · Go · Merge PR #12?\n\nNeeds you: 1 decision, 0 actions — on the card.');
    now = T0 + 10 * 60_000;
    expect(ledger.list('s1', 'coord', { forRecap: true }).paste).toContain('New:\n- N1 · Go · Merge PR #12?'); // new until this recap
    now = T0 + 20 * 60_000;
    ledger.add('s1', 'coord', { kind: 'do', text: 'Check the banner on staging.' });
    expect(ledger.list('s1', 'coord').paste).toBe('New:\n- N2 · Do · Check the banner on staging.\n\nNeeds you: 1 decision, 1 action — on the card.');
  });
});

describe('import', () => {
  it('loads items as imported; an unchecked imported decision can be confirmed with a quote', () => {
    const out = ledger.importItems('s1', 'coord', [
      { kind: 'go', text: 'Merge PR #9.', ...GO_CARD },
      { kind: 'decide', text: 'Use library A?', ...DECIDE_CARD, status: 'answered' },
      { kind: 'statement', text: 'keep prices as they are' },
    ]);
    expect(out).toEqual({ ids: ['N1', 'N2', 'N3'] });
    expect(ledgerDb.listBySession(db, 's1').map((i) => [i.origin, i.status, i.author])).toEqual([
      ['imported', 'open', 'overseer'], ['imported', 'answered', 'overseer'], ['imported', 'answered', 'you'],
    ]);
    expect(ledger.list('s1', 'coord').text).toContain('- N2 [Decide] Use library A?\n  Recommendation: A. 5 nights\n  Options: A. 5 nights | B. 10 nights\n  Imported, not checked');

    userSays('yes, library A', 2);
    const confirmed = ledger.resolve('s1', 'coord', { id: 'N2', status: 'answered', quote: 'library A' });
    expect(confirmed.line).toContain('You approved: "Use library A?" → "library A"');
    expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N2', status: 'answered', quote: 'library A' }), 409);
  });

  it('a withdrawn imported item is closed: it cannot be resolved again, and it renders the withdrawal', () => {
    ledger.importItems('s1', 'coord', [{ kind: 'decide', text: 'Use library A?', ...DECIDE_CARD, status: 'answered' }]);
    const out = ledger.resolve('s1', 'coord', { id: 'N1', status: 'withdrawn', reason: 'the import was wrong' });
    expect(out.line).toBe('N1 [Decide] Use library A?\n  Recommendation: A. 5 nights\n  Options: A. 5 nights | B. 10 nights\n  Withdrawn by overseer: the import was wrong\n  Imported, not checked');
    userSays('library A', 2);
    for (const status of ['answered', 'parked']) {
      const e = expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N1', status, quote: 'library A' }), 409, 'N1 is already withdrawn.');
      expect(e.body).toEqual({ status: 'withdrawn' });
    }
    expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N1', status: 'withdrawn', reason: 'again' }), 409);
    expect(ledgerDb.getBySeq(db, 's1', 1)).toMatchObject({ status: 'withdrawn', reason: 'the import was wrong', quote: null });
  });

  it('a superseded imported item is closed', () => {
    ledger.importItems('s1', 'coord', [{ kind: 'decide', text: 'Set the first store to Draft?', ...DECIDE_CARD }]);
    ledger.add('s1', 'coord', { kind: 'decide', text: 'Also set the second store to Draft?', ...DECIDE_CARD, supersedes: 'N1' });
    expect(ledgerDb.getBySeq(db, 's1', 1)!.status).toBe('superseded');
    userSays('yes, the first store', 2);
    expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N1', status: 'answered', quote: 'the first store' }), 409, 'N1 is already superseded.');
    expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N1', status: 'withdrawn', reason: 'moot' }), 409, 'N1 is already superseded.');
  });

  it('an unchecked imported parked item can still be confirmed once', () => {
    ledger.importItems('s1', 'coord', [{ kind: 'decide', text: 'Rename the CLI?', ...DECIDE_CARD, status: 'parked' }]);
    userSays('park the rename', 2);
    expect(ledger.resolve('s1', 'coord', { id: 'N1', status: 'parked', quote: 'park the rename' }).status).toBe('parked');
    expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N1', status: 'parked', quote: 'park the rename' }), 409);
  });

  it('rejects an empty list or a bad item, and creates nothing', () => {
    expectLedgerError(() => ledger.importItems('s1', 'coord', []), 400);
    expectLedgerError(() => ledger.importItems('s1', 'coord', [{ kind: 'go', text: 'ok', ...GO_CARD }, { kind: 'nope', text: 'x' }]), 400);
    expect(ledgerDb.listBySession(db, 's1')).toEqual([]);
  });
});

describe('handoff', () => {
  it('renders the verbatim block for the given IDs, and 404s an unknown ID', () => {
    ledger.add('s1', 'coord', { kind: 'decide', text: 'Use library A?', ...DECIDE_CARD });
    userSays('A', 1);
    ledger.resolve('s1', 'coord', { id: 'N1', status: 'answered', quote: 'A' });
    expect(ledger.handoff('s1', 'coord', ['N1']).block).toBe(
      'Owner decisions (verbatim, from the ledger):\n- N1 [Decide] Use library A?\n  Recommendation: A. 5 nights\n  Options: A. 5 nights | B. 10 nights\n  You approved: "Use library A?" → "A" (Mon 16:01)',
    );
    expectLedgerError(() => ledger.handoff('s1', 'coord', ['N1', 'N5']), 404, 'Unknown ledger item: N5');
  });
});

// Decision cards, Unit 4: the triage tools and the reversal.
describe('triage tools', () => {
  const AGENT = { id: 'agent', label: 'worker', mission: null };
  /** N1 and N2 proposed by the agent; returns nothing. */
  const propose = () => {
    ledger.captureAgentBlock('s1', AGENT, [LR6, { ...LR6, id: 'LR-7', question: 'Which day does the switch happen?' }]);
  };

  it('ledger_add_from_agent: the agent\'s text stays word for word; the note becomes the overseer\'s note; the item is sent now', () => {
    propose();
    now = T0 + 5 * 60_000;
    expect(ledger.addFromAgent('s1', 'coord', { id: 'N1', note: 'The agent did not know about the holiday freeze.' })).toEqual({ id: 'N1', status: 'open' });
    const item = ledgerDb.getBySeq(db, 's1', 1)!;
    expect(item).toMatchObject({
      status: 'open', text: LR6.question, context: LR6.context, options: LR6.options, recommendation: LR6.recommendation,
      recommendationWhy: LR6.why, defaultText: LR6.default, overseerNote: 'The agent did not know about the holiday freeze.', sentAt: min(5),
    });
    expect(renderCard(item, { now, timeZone: 'UTC' })).toContain("**Overseer's note:** The agent did not know about the holiday freeze.");
    expect(ledger.addFromAgent('s1', 'coord', { id: 'N2' })).toEqual({ id: 'N2', status: 'open' });
    expect(ledgerDb.getBySeq(db, 's1', 2)!.overseerNote).toBeNull();
    expectLedgerError(() => ledger.addFromAgent('s1', 'coord', { id: 'N1' }), 409, 'N1 is already open.');
    expectLedgerError(() => ledger.addFromAgent('s1', 'coord', { id: 'N9' }), 404);
  });

  it('ledger_add_from_agent takes blocks: the overseer says what the item holds up, and the card ranks first', () => {
    propose(); // N1, N2
    ledger.add('s1', 'coord', { kind: 'decide', text: 'Which store goes first?', ...DECIDE_CARD }); // N3, sent first
    now = T0 + 5 * 60_000;
    ledger.addFromAgent('s1', 'coord', { id: 'N2', blocks: 'the switch to live mode' });
    ledger.addFromAgent('s1', 'coord', { id: 'N1' });
    expect(ledgerDb.getBySeq(db, 's1', 2)!.blocks).toBe('the switch to live mode');
    expect(ledgerDb.getBySeq(db, 's1', 1)!.blocks).toBeNull();
    ledger.list('s1', 'coord', { forRecap: true });
    for (let i = 0; i < 6; i++) ledger.add('s1', 'coord', { kind: 'decide', text: `Old question ${i}?`, ...DECIDE_CARD });
    now = T0 + 10 * 60_000;
    ledger.list('s1', 'coord', { forRecap: true }); // now nothing is new: the top 5 rank by "holds up work", then age
    const cards = [...ledger.list('s1', 'coord').text.matchAll(/^\*\*N(\d+) · Decide:\*\*/gm)].map((m) => Number(m[1]));
    expect(cards[0]).toBe(2);
    expect(renderCard(ledgerDb.getBySeq(db, 's1', 2)!, { now, timeZone: 'UTC' })).toContain('Holds up: the switch to live mode · Open 5 minutes');
  });

  it('ledger_decide_self: records the choice and the reason; the recap shows it once', () => {
    propose();
    const out = ledger.decideSelf('s1', 'coord', { id: 'N2', choice: 'Monday', reason: 'it avoids the weekend peak' });
    expect(out).toEqual({
      id: 'N2', status: 'decided_by_overseer',
      line: '- **N2 · Decided by overseer:** Which day does the switch happen? → Monday. Reason: it avoids the weekend peak. (Reply "reverse N2" to change it.)',
    });
    expect(ledgerDb.getBySeq(db, 's1', 2)).toMatchObject({ status: 'decided_by_overseer', decidedChoice: 'Monday', reason: 'it avoids the weekend peak', decidedAt: min(0), sentAt: null });
    const recap = ledger.list('s1', 'coord', { forRecap: true }).text;
    expect(recap).toContain('Decided since the last recap:\n- **N2 · Decided by overseer:** Which day does the switch happen? → Monday.');
    expect(recap).toContain('Overseer decisions in the last 7 days: 1. Reversed by you: 0.');
    now = T0 + 60_000;
    expect(ledger.list('s1', 'coord').text).not.toContain('N2 · Decided by overseer'); // shown once
    expectLedgerError(() => ledger.decideSelf('s1', 'coord', { id: 'N1', choice: 'A. 5 nights' }), 400);
    expectLedgerError(() => ledger.decideSelf('s1', 'coord', { id: 'N1', reason: 'x' }), 400);
  });

  it('ledger_decide_self refuses a go item, a user-sourced item, and an item already sent to the user', () => {
    const go = { id: 'G1', kind: 'go', question: 'Merge the sync PR?', context: 'The sync PR is reviewed and green.', default: 'Nothing happens.' };
    ledger.captureAgentBlock('s1', AGENT, [go]); // N1: a proposed go item
    expectLedgerError(() => ledger.decideSelf('s1', 'coord', { id: 'N1', choice: 'merge', reason: 'green' }), 422, 'Only the user can decide this item.');
    userSays('we should switch to live mode soon', 1);
    ledgerDb.create(db, { sessionId: 's1', kind: 'decide', text: 'Switch when?', author: 'overseer', status: 'proposed', sourceKind: 'user', sourceRef: 'switch to live mode soon' }); // N2
    expectLedgerError(() => ledger.decideSelf('s1', 'coord', { id: 'N2', choice: 'now', reason: 'x' }), 422, ONLY_USER_ERROR);
    ledger.add('s1', 'coord', { kind: 'decide', text: 'Which store goes first?', ...DECIDE_CARD }); // N3, sent at once
    expectLedgerError(() => ledger.decideSelf('s1', 'coord', { id: 'N3', choice: 'A. 5 nights', reason: 'x' }), 422, ONLY_USER_ERROR);
    propose(); // N4, N5
    ledger.addFromAgent('s1', 'coord', { id: 'N4' }); // sent to the user by triage
    expectLedgerError(() => ledger.decideSelf('s1', 'coord', { id: 'N4', choice: 'A. 5 nights', reason: 'x' }), 422, ONLY_USER_ERROR);
    ledger.decideSelf('s1', 'coord', { id: 'N5', choice: 'Monday', reason: 'x' });
    expectLedgerError(() => ledger.decideSelf('s1', 'coord', { id: 'N5', choice: 'Tuesday', reason: 'y' }), 409, 'N5 is already decided_by_overseer.');
    expect(ledgerDb.getBySeq(db, 's1', 5)!.decidedChoice).toBe('Monday');
  });

  // Overseer memory scope (spec 2026-10-07), Unit 4: a thread's item is the user's to decide.
  it("ledger_decide_self refuses an item sourced from one of the user's threads", () => {
    ledgerDb.create(db, { sessionId: 's1', kind: 'decide', text: 'Switch when?', author: 'overseer', status: 'proposed', sourceKind: 'thread', sourceRef: 'plain' }); // N1
    expectLedgerError(() => ledger.decideSelf('s1', 'coord', { id: 'N1', choice: 'now', reason: 'x' }), 422, ONLY_USER_ERROR);
    expect(ledgerDb.getBySeq(db, 's1', 1)!.status).toBe('proposed');
  });

  it('a reversal: ledger_resolve to answered on an overseer decision, with the user\'s checked quote; the count line counts it', () => {
    propose(); // created at minute 0
    userSays('switch on a Tuesday', 1); // after the item was created, but before the decision: never counts
    now = T0 + 2 * 60_000;
    ledger.decideSelf('s1', 'coord', { id: 'N2', choice: 'Monday', reason: 'it avoids the weekend peak' }); // decided at minute 2
    expect(ledgerDb.getBySeq(db, 's1', 2)).toMatchObject({ createdAt: min(0), decidedAt: min(2) });
    expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N2', status: 'answered', quote: 'switch on a Tuesday' }), 422, quoteNotFoundAfterError(2));
    userSays('reverse N2, use Tuesday', 3);
    now = T0 + 4 * 60_000;
    const out = ledger.resolve('s1', 'coord', { id: 'N2', status: 'answered', quote: 'reverse N2, use Tuesday' });
    expect(out.status).toBe('answered');
    expect(out.line.split('\n').pop()).toBe('  You reversed the overseer\'s choice "Monday": "reverse N2, use Tuesday" (Mon 16:03)');
    expect(ledgerDb.getBySeq(db, 's1', 2)).toMatchObject({ status: 'answered', quote: 'reverse N2, use Tuesday', decidedChoice: 'Monday' });
    expect(ledger.list('s1', 'coord').text).toContain('Overseer decisions in the last 7 days: 1. Reversed by you: 1.');
    // Only answered reverses an overseer decision; parking or withdrawing it is not a thing.
    ledger.decideSelf('s1', 'coord', { id: 'N1', choice: 'A. 5 nights', reason: 'x' });
    userSays('park N1', 5);
    expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N1', status: 'parked', quote: 'park N1' }), 409, 'N1 is already decided_by_overseer.');
  });

  /** A low-level decision the overseer records itself (ledger_decide_self without an id). */
  const OWN = {
    text: 'Which retry helper?',
    context: 'The sync retries failed writes. Two helpers can do it; both meet the plan.',
    options: [
      { label: 'the existing helper', effect: 'No new code; it already covers this case.' },
      { label: 'a new helper', effect: 'About 80 lines of new code and tests.' },
    ],
    recommendation: 'the existing helper',
    why: 'It already covers this case.',
    default: 'The agent uses the existing helper.',
    source: { kind: 'overseer' },
    choice: 'the existing helper',
    reason: 'it already covers this case',
  };

  it('ledger_decide_self without an id: a new item, already decided; the recap and the count show it; the user can reverse it', () => {
    now = T0 + 60_000;
    const out = ledger.decideSelf('s1', 'coord', OWN);
    expect(out).toEqual({
      id: 'N1', status: 'decided_by_overseer',
      line: '- **N1 · Decided by overseer:** Which retry helper? → the existing helper. Reason: it already covers this case. (Reply "reverse N1" to change it.)',
    });
    expect(ledgerDb.getBySeq(db, 's1', 1)).toMatchObject({
      kind: 'decide', status: 'decided_by_overseer', author: 'overseer', text: 'Which retry helper?', context: OWN.context,
      options: OWN.options, recommendation: OWN.recommendation, recommendationWhy: OWN.why, defaultText: OWN.default,
      sourceKind: 'overseer', decidedChoice: 'the existing helper', reason: 'it already covers this case',
      createdAt: min(1), decidedAt: min(1), sentAt: null,
    });
    const recap = ledger.list('s1', 'coord', { forRecap: true }).text;
    expect(recap).toContain('Needs you now:\n- none');
    expect(recap).toContain('Decided since the last recap:\n- **N1 · Decided by overseer:** Which retry helper? → the existing helper.');
    expect(recap).toContain('Overseer decisions in the last 7 days: 1. Reversed by you: 0.');

    userSays('reverse N1, write a new helper', 3);
    now = T0 + 4 * 60_000;
    const reversed = ledger.resolve('s1', 'coord', { id: 'N1', status: 'answered', quote: 'reverse N1, write a new helper' });
    expect(reversed.line.split('\n').pop()).toBe('  You reversed the overseer\'s choice "the existing helper": "reverse N1, write a new helper" (Mon 16:03)');
    const next = ledger.list('s1', 'coord').text;
    expect(next).toContain('Overseer decisions in the last 7 days: 1. Reversed by you: 1.');
    expect(next).toContain('Decided since the last recap:\n- N1 [Decide] Which retry helper?');
  });

  it('ledger_decide_self without an id: forces decide, runs the card checks, and refuses a go kind and a user source', () => {
    expectLedgerError(() => ledger.decideSelf('s1', 'coord', { ...OWN, kind: 'go' }), 422, ONLY_USER_ERROR);
    userSays('use the existing helper', 1);
    expectLedgerError(() => ledger.decideSelf('s1', 'coord', { ...OWN, source: { kind: 'user', ref: 'use the existing helper' } }), 422, ONLY_USER_ERROR);
    expectLedgerError(() => ledger.decideSelf('s1', 'coord', { ...OWN, source: { kind: 'thread', ref: 'plain' } }), 422, ONLY_USER_ERROR);
    const { why: _w, ...noWhy } = OWN;
    expectLedgerError(() => ledger.decideSelf('s1', 'coord', noWhy), 422, 'A decision card needs: why. Add them and try again.');
    expectLedgerError(() => ledger.decideSelf('s1', 'coord', { ...OWN, text: 'Keep D1 to D9 as they are?' }), 422, 'One decision per card. Add each decision on its own.');
    expectLedgerError(() => ledger.decideSelf('s1', 'coord', { ...OWN, source: { kind: 'pr', ref: 'twelve' } }), 422, 'The source does not exist in this project: twelve.');
    expectLedgerError(() => ledger.decideSelf('s1', 'coord', { ...OWN, text: ' ' }), 400);
    expectLedgerError(() => ledger.decideSelf('s1', 'coord', { ...OWN, choice: '' }), 400);
    expectLedgerError(() => ledger.decideSelf('s1', 'coord', { ...OWN, reason: undefined }), 400);
    expectLedgerError(() => ledger.decideSelf('s1', 'agent', OWN), 403, NOT_OVERSEER_ERROR);
    expect(ledgerDb.listBySession(db, 's1')).toEqual([]);
    expect(ledger.decideSelf('s1', 'coord', { ...OWN, kind: 'do' }).id).toBe('N1'); // any other kind is a decide
    expect(ledgerDb.getBySeq(db, 's1', 1)!.kind).toBe('decide');
  });

  it('ledger_mark_default: the item stays open and moves to "Running on defaults"', () => {
    ledger.add('s1', 'coord', { kind: 'decide', text: 'Abort when duplicates pass 1%?', ...DECIDE_CARD, default: 'abort above 1%' });
    const out = ledger.markDefault('s1', 'coord', { id: 'N1' });
    expect(out).toEqual({ id: 'N1', line: '- **N1 · Decide:** Abort when duplicates pass 1%? Running on the default "abort above 1%" since Oct 5. Recommended: A. 5 nights. (type `show N1`)' });
    expect(ledgerDb.getBySeq(db, 's1', 1)).toMatchObject({ status: 'open', onDefaultSince: min(0) });
    now = T0 + 86_400_000;
    ledger.markDefault('s1', 'coord', { id: 'N1' }); // again: the start date stays
    expect(ledgerDb.getBySeq(db, 's1', 1)!.onDefaultSince).toBe(min(0));
    const recap = ledger.list('s1', 'coord').text;
    expect(recap).toContain('Needs you now:\n- none');
    expect(recap).toContain('Running on defaults:\n- **N1 · Decide:** Abort when duplicates pass 1%?');
    expect(ledger.list('s1', 'coord').openIds).toEqual(['N1']);
    ledger.add('s1', 'coord', { kind: 'do', text: 'Check staging.' });
    expectLedgerError(() => ledger.markDefault('s1', 'coord', { id: 'N2' }), 400);
    userSays('abort above 1% is fine', 2000);
    ledger.resolve('s1', 'coord', { id: 'N1', status: 'answered', quote: 'abort above 1% is fine' });
    expectLedgerError(() => ledger.markDefault('s1', 'coord', { id: 'N1' }), 409, 'N1 is already answered.');
  });

  it('ledger_show: full cards for one, several, and all open decisions', () => {
    ledger.add('s1', 'coord', { kind: 'decide', text: 'Which store goes first?', ...DECIDE_CARD });
    ledger.add('s1', 'coord', { kind: 'go', text: 'Merge PR #12?', ...GO_CARD });
    ledger.add('s1', 'coord', { kind: 'do', text: 'Check staging.' });
    propose(); // N4, N5: proposed, not open
    const card = (seq: number) => renderCard(ledgerDb.getBySeq(db, 's1', seq)!, { now, timeZone: 'UTC', lookup: (s) => ledgerDb.getBySeq(db, 's1', s) });
    expect(ledger.show('s1', 'coord', { ids: ['N2'] })).toEqual({ text: card(2) });
    expect(ledger.show('s1', 'coord', { ids: 'N1' })).toEqual({ text: card(1) });
    expect(ledger.show('s1', 'coord', { ids: ['N1', 'N4'] }).text).toBe(`${card(1)}\n\n${card(4)}`);
    expect(ledger.show('s1', 'coord', { ids: ['N3'] }).text).toBe('N3 [Do] Check staging. (open 0m)\n  Proposed by overseer, not approved');
    expect(ledger.show('s1', 'coord', { all: true }).text).toBe(`${card(1)}\n\n${card(2)}`);
    expectLedgerError(() => ledger.show('s1', 'coord', {}), 400);
    expectLedgerError(() => ledger.show('s1', 'coord', { ids: ['N9'] }), 404);
    ledger.markDefault('s1', 'coord', { id: 'N1' });
    expect(ledger.show('s1', 'coord', { all: true }).text).toContain('Running on the default since Oct 5'); // still open: still shown
  });

  // Overseer memory scope (spec 2026-10-07), Unit 5: the rules are one line in the recap; the full
  // list rides in a separate field and prints on "show rules".
  it('ledger_list: the recap has the rules line; the rules field and ledger_show({ rules: true }) have the full list', () => {
    expect(ledger.list('s1', 'coord').rules).toEqual([]);
    expect(ledger.show('s1', 'coord', { rules: true })).toEqual({ text: 'No project rules.' });
    userSays('never deploy on Fridays', 1);
    userSays('always ask before a release', 2);
    ledger.note('s1', 'coord', { quote: 'never deploy on Fridays', policy: true });
    ledger.note('s1', 'coord', { quote: 'always ask before a release', policy: true });
    // The first recap after a rule shows it once under "Decided since the last recap"; later recaps
    // carry only the one line.
    expect(ledger.list('s1', 'coord', { forRecap: true }).text).toContain('Decided since the last recap:\n- N1 You said: "never deploy on Fridays"');
    now += 60_000;
    const out = ledger.list('s1', 'coord');
    expect(out.text.split('\n\n')[0]).toBe('Project rules: 2 in force (type "show rules").');
    expect(out.text).not.toContain('never deploy on Fridays');
    expect(out.rules).toEqual(['N1 You said: "never deploy on Fridays" (Mon 16:01)', 'N2 You said: "always ask before a release" (Mon 16:02)']);
    expect(ledger.show('s1', 'coord', { rules: true }).text).toBe(
      'Project rules (your words):\n- N1 You said: "never deploy on Fridays" (Mon 16:01)\n- N2 You said: "always ask before a release" (Mon 16:02)',
    );
  });

  it('ledger_show all with no open decision', () => {
    expect(ledger.show('s1', 'coord', { all: true })).toEqual({ text: 'No open decisions.' });
  });

  it('every triage tool is overseer only', () => {
    propose();
    for (const run of [
      () => ledger.addFromAgent('s1', 'agent', { id: 'N1' }),
      () => ledger.decideSelf('s1', 'agent', { id: 'N1', choice: 'x', reason: 'y' }),
      () => ledger.markDefault('s1', 'agent', { id: 'N1' }),
      () => ledger.show('s1', 'agent', { all: true }),
    ]) expectLedgerError(run, 403, NOT_OVERSEER_ERROR);
  });
});
