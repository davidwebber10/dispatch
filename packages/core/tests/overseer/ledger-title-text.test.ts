// The title in the overseer's text (titles and source panel spec 2026-10-09, Unit 3): the paste
// block, the ledger_add line and the ledger_show card use the title; ledger_list lists the open
// items without one for the overseer's own use. An item without a title keeps today's text.
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { LedgerItem } from '../../src/db/ledger.js';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as ledgerDb from '../../src/db/ledger.js';
import { LedgerService } from '../../src/overseer/ledger-service.js';
import { renderAddLine, renderCard, renderRecapPaste, renderUntitledList } from '../../src/overseer/ledger-render.js';
import { DECIDE_CARD, GO_CARD } from './card-fixtures.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-09T18:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const LAST = ago(DAY);

function item(over: Partial<LedgerItem>): LedgerItem {
  return {
    id: 1, sessionId: 's1', seq: 1, kind: 'decide', text: 'Which store goes first?', author: 'overseer',
    recommendation: null, options: null, blocks: null, mission: null, status: 'open',
    quote: null, quoteMessageId: null, quoteAt: null, reading: null, reason: null, supersedes: null,
    origin: 'live', createdAt: ago(2 * DAY), updatedAt: ago(2 * DAY),
    context: null, recommendationWhy: null, defaultText: null, sourceKind: null, sourceRef: null,
    sourceSection: null, sourceId: null, overseerNote: null, onDefaultSince: null, agentTerminalId: null,
    agentDecisionId: null, decidedChoice: null, decidedAt: null, policy: false, sentAt: ago(2 * DAY), title: null,
    ...over,
  };
}

const BOARD = 'Do you approve the merge of board PR #26 (docs/BOARD.md update for 2026-10-09)?';

describe('renderAddLine — the title, when there is one', () => {
  it('"N41 · Go · title"; without a title, the question as before', () => {
    expect(renderAddLine(item({ seq: 41, kind: 'go', text: BOARD, title: 'Merge board PR #26' })))
      .toBe('N41 · Go · Merge board PR #26 — the full card is on the pinned card.');
    expect(renderAddLine(item({ seq: 55, kind: 'do', text: 'Check the banner on staging.' })))
      .toBe('N55 · Do · Check the banner on staging. — the full card is on the pinned card.');
  });
});

describe('renderRecapPaste — the title in the New and Decided lines', () => {
  it('a titled item shows its title; an item without one keeps its question; the count line does not change', () => {
    const items = [
      item({ seq: 41, kind: 'do', text: 'Check the banner on staging, then the footer, then the cart page.', title: 'Check the staging pages', sentAt: ago(1_000) }),
      item({ seq: 42, text: 'How many clean nights before live mode?', recommendation: 'A. 5 nights', title: 'Clean nights before live mode', sentAt: ago(2_000) }),
      item({ seq: 43, kind: 'go', text: 'Merge PR #62?', sentAt: ago(3_000) }),
      item({ seq: 80, kind: 'go', text: BOARD, title: 'Merge board PR #26', status: 'answered', quote: 'N80: merge', updatedAt: ago(500) }),
      item({ seq: 81, text: 'Use library A?', status: 'answered', quote: 'A', updatedAt: ago(400) }),
    ];
    expect(renderRecapPaste(items, { now: NOW, lastRecapAt: LAST })).toBe([
      'New:',
      '- N41 · Do · Check the staging pages',
      '- N42 · Decide · Clean nights before live mode · Rec: A. 5 nights',
      '- N43 · Go · Merge PR #62?',
      '',
      'Decided:',
      '- N80 · Go · Merge board PR #26 · Your answer: "N80: merge"',
      '- N81 · Decide · Use library A? · Your answer: "A"',
      '',
      'Needs you: 2 decisions, 1 action — on the card.',
    ].join('\n'));
  });
});

describe('renderCard — ledger_show: the title in the header, the question below it', () => {
  it('with a title', () => {
    const card = renderCard(item({ seq: 17, text: 'How many clean nights before live mode?', title: 'Clean nights before live mode', sentAt: ago(2 * DAY) }), { now: NOW, timeZone: 'UTC' });
    expect(card.startsWith('**N17 · Decide · Clean nights before live mode**\n\nHow many clean nights before live mode?\n\nHolds up: nothing · Open 2 days')).toBe(true);
  });

  it('without a title, as before', () => {
    const card = renderCard(item({ seq: 17, text: 'How many clean nights before live mode?' }), { now: NOW, timeZone: 'UTC' });
    expect(card.startsWith('**N17 · Decide:** How many clean nights before live mode?\n\nHolds up: nothing')).toBe(true);
  });
});

describe('renderUntitledList — "Open items without a title", for the overseer\'s own use', () => {
  it('every go, decide and do item that is open or parked and has no title: the ID, the kind and the question, one line each', () => {
    const items = [
      item({ seq: 1, kind: 'statement', text: 'never deploy on Fridays', status: 'answered' }),
      item({ seq: 2, kind: 'go', text: BOARD }),
      item({ seq: 3, kind: 'do', text: 'Check the banner\non staging.', status: 'parked' }),
      item({ seq: 4, text: 'Use library A?', title: 'Library A or B' }),
      item({ seq: 5, text: 'Use library C?', status: 'answered' }),
      item({ seq: 6, text: 'Which day?', status: 'proposed' }),
      item({ seq: 7, text: 'x'.repeat(400) }),
    ];
    expect(renderUntitledList(items)).toBe([
      'Open items without a title:',
      `- N2 · Go · ${BOARD}`,
      '- N3 · Do · Check the banner on staging.',
      `- N7 · Decide · ${'x'.repeat(149)}…`,
    ].join('\n'));
  });

  it('null when every open item has a title', () => {
    expect(renderUntitledList([item({ title: 'Store order' }), item({ seq: 2, status: 'answered' })])).toBeNull();
  });
});

describe('the service — ledger_list and ledger_add', () => {
  let db: Database.Database;
  let ledger: LedgerService;
  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
    terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
    ledger = new LedgerService(db, { clock: () => NOW, timeZone: 'UTC' });
  });

  it('ledger_add returns the line with the title', () => {
    expect(ledger.add('s1', 'coord', { kind: 'go', text: BOARD, ...GO_CARD, title: 'Merge board PR #26' }).line)
      .toBe('N1 · Go · Merge board PR #26 — the full card is on the pinned card.');
  });

  it('ledger_list: the own-use text ends with the open items without a title; the list goes once they all have one', () => {
    ledger.importItems('s1', 'coord', [
      { kind: 'decide', text: 'Use library A?', status: 'parked', ...DECIDE_CARD, title: undefined },
      { kind: 'do', text: 'Check staging.', title: 'Check staging' },
    ]);
    ledgerDb.create(db, { sessionId: 's1', kind: 'go', text: 'Merge PR #62?', author: 'overseer', now: ago(DAY) }); // an older row, no title
    const text = ledger.list('s1', 'coord').text;
    expect(text.endsWith('\n\nOpen items without a title:\n- N1 · Decide · Use library A?\n- N3 · Go · Merge PR #62?')).toBe(true);
    ledger.setTitle('s1', 'coord', { id: 'N1', title: 'Library A or B' });
    ledger.setTitle('s1', 'coord', { id: 'N3', title: 'Merge PR #62' });
    expect(ledger.list('s1', 'coord').text).not.toContain('Open items without a title');
  });
});
