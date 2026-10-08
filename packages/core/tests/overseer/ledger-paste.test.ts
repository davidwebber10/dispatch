// The recap paste block and ledger_add's one line (pinned card spec 2026-10-08, Unit 5). The recap
// is news: the full ledger stays on the pinned card.
import { describe, it, expect } from 'vitest';
import type { LedgerItem } from '../../src/db/ledger.js';
import { renderAddLine, renderRecapPaste } from '../../src/overseer/ledger-render.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-08T18:00:00.000Z');
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
    agentDecisionId: null, decidedChoice: null, decidedAt: null, policy: false, sentAt: ago(2 * DAY),
    ...over,
  };
}

describe('renderAddLine — what ledger_add returns for the chat', () => {
  it('one line: the number, the kind and the question, and where the full card is', () => {
    expect(renderAddLine(item({ seq: 60, kind: 'go', text: 'Merge PR #12 into main?' })))
      .toBe('N60 · Go · Merge PR #12 into main? — the full card is on the pinned card.');
    expect(renderAddLine(item({ seq: 17, text: 'How many clean nights before live mode?', recommendation: 'A. 5 nights' })))
      .toBe('N17 · Decide · How many clean nights before live mode? — the full card is on the pinned card.');
    expect(renderAddLine(item({ seq: 55, kind: 'do', text: 'Check the banner on staging.' })))
      .toBe('N55 · Do · Check the banner on staging. — the full card is on the pinned card.');
  });
});

describe('renderRecapPaste — the part the overseer pastes into the recap', () => {
  const items = [
    item({ seq: 1, kind: 'statement', text: 'never deploy on Fridays', author: 'you', status: 'answered', quote: 'never deploy on Fridays', quoteAt: ago(1_000), updatedAt: ago(1_000), policy: true }),
    item({ seq: 2, kind: 'go', text: 'Merge PR #62?', sentAt: ago(1_000) }),
    item({ seq: 3, text: 'How many clean nights before live mode?', recommendation: 'A. 5 nights', sentAt: ago(2_000) }),
    item({ seq: 4, kind: 'do', text: 'Check the banner on staging.', sentAt: ago(3_000) }),
    item({ seq: 5, text: 'Use library A?', status: 'answered', quote: 'N5: A', quoteAt: ago(1_000), updatedAt: ago(1_000) }),
    item({ seq: 6, text: 'Which retry helper?', status: 'decided_by_overseer', decidedChoice: 'the existing one', reason: 'it covers this case', decidedAt: ago(1_000), updatedAt: ago(1_000), sentAt: null }),
    item({ seq: 7, kind: 'do', text: 'Drop the old tag check.', status: 'withdrawn', reason: 'moot', updatedAt: ago(500) }),
    item({ seq: 8, text: 'Which day?', status: 'answered', decidedChoice: 'Monday', decidedAt: ago(2 * DAY), quote: 'reverse N8, use Tuesday', quoteAt: ago(900), updatedAt: ago(900) }),
    item({ seq: 9, text: 'Keep the old flag?' }), // open, not new: on the card only
    item({ seq: 10, kind: 'do', text: 'Rotate the test key.' }), // open, not new
    item({ seq: 11, text: 'Abort above 1%?', onDefaultSince: ago(DAY) }),
  ];

  it('the New lines, the Decided lines and the count line', () => {
    expect(renderRecapPaste(items, { now: NOW, lastRecapAt: LAST })).toBe([
      'New:\n' +
      '- N2 · Go · Merge PR #62?\n' +
      '- N3 · Decide · How many clean nights before live mode? · Rec: A. 5 nights\n' +
      '- N4 · Do · Check the banner on staging.',
      'Decided:\n' +
      '- N1 · You said: "never deploy on Fridays" · a project rule\n' +
      '- N5 · Decide · Use library A? · Your answer: "N5: A"\n' +
      '- N7 · Do · Drop the old tag check. · Withdrawn: moot\n' +
      '- N8 · Decide · Which day? · You reversed the overseer\'s choice "Monday": "reverse N8, use Tuesday"\n' +
      '- N6 · Decide · Which retry helper? · Decided by overseer: the existing one',
      'Needs you: 3 decisions, 2 actions — on the card.',
    ].join('\n\n'));
  });

  it('a group with no lines is left out; the count line is singular for one', () => {
    const one = [item({ seq: 1, kind: 'go', text: 'Merge PR #9?' }), item({ seq: 2, kind: 'do', text: 'Check staging.' })];
    expect(renderRecapPaste(one, { now: NOW, lastRecapAt: LAST })).toBe('Needs you: 1 decision, 1 action — on the card.');
    expect(renderRecapPaste([], { now: NOW, lastRecapAt: null })).toBe('Needs you: 0 decisions, 0 actions — on the card.');
  });

  it('an imported item is never new, and an unchecked imported answer says so', () => {
    const out = renderRecapPaste([
      item({ seq: 1, kind: 'go', text: 'Deploy?', origin: 'imported', sentAt: ago(1_000) }),
      item({ seq: 2, text: 'Use library B?', origin: 'imported', status: 'answered', updatedAt: ago(1_000) }),
    ], { now: NOW, lastRecapAt: LAST });
    expect(out).not.toContain('New:');
    expect(out).toContain('- N2 · Decide · Use library B? · Imported, not checked');
  });

  it('no line names a ledger number without its question', () => {
    const out = renderRecapPaste(items, { now: NOW, lastRecapAt: LAST });
    for (const line of out.split('\n').filter((l) => l.startsWith('- '))) expect(line).toMatch(/^- N\d+ · \S.{8,}/);
  });
});
