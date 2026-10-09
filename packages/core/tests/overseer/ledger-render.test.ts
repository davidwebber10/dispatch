import { describe, it, expect } from 'vitest';
import { parseOptions, type LedgerItem } from '../../src/db/ledger.js';
import { formatAge, formatStamp, renderItem, renderLedgerSections, renderHandoffBlock } from '../../src/overseer/ledger-render.js';

const NOW = Date.parse('2026-10-05T18:51:00.000Z'); // a Monday
const AT = '2026-10-05T16:51:00.000Z';
const ctx = { now: NOW, timeZone: 'UTC' };

function item(over: Partial<LedgerItem>): LedgerItem {
  return {
    id: 1, sessionId: 's1', seq: 1, kind: 'decide', text: 'Which store goes first?', author: 'overseer',
    recommendation: null, options: null, blocks: null, mission: null, status: 'open',
    quote: null, quoteMessageId: null, quoteAt: null, reading: null, reason: null, supersedes: null,
    origin: 'live', createdAt: '2026-10-05T16:00:00.000Z', updatedAt: '2026-10-05T16:00:00.000Z',
    context: null, recommendationWhy: null, defaultText: null, sourceKind: null, sourceRef: null,
    sourceSection: null, sourceId: null, overseerNote: null, onDefaultSince: null, agentTerminalId: null,
    agentDecisionId: null, decidedChoice: null, decidedAt: null, policy: false, sentAt: '2026-10-05T16:00:00.000Z', title: null,
    ...over,
  };
}

describe('formatStamp / formatAge', () => {
  it('formats a stamp as weekday plus 24-hour time', () => {
    expect(formatStamp(AT, 'UTC')).toBe('Mon 16:51');
    expect(formatStamp('2026-10-05T00:05:00.000Z', 'UTC')).toBe('Mon 00:05');
  });
  it('formats ages in minutes, hours, then days', () => {
    expect(formatAge(42 * 60_000)).toBe('42m');
    expect(formatAge(5 * 3_600_000)).toBe('5h');
    expect(formatAge(47 * 3_600_000)).toBe('47h');
    expect(formatAge(3 * 86_400_000)).toBe('3d');
  });
});

describe('renderItem — the labels', () => {
  it('an old #62 row (plain-string options, no card fields) still renders as before', () => {
    const old = item({ recommendation: 'the first store', options: parseOptions('["A","B"]'), blocks: 'the import agent' });
    expect(renderItem(old, ctx)).toBe(
      'N1 [Decide] Which store goes first? (open 2h)\n' +
      '  Recommendation: the first store\n' +
      '  Options: A | B\n' +
      '  Blocks: the import agent\n' +
      '  Proposed by overseer, not approved',
    );
  });

  it('a proposed item and an item the overseer decided itself', () => {
    expect(renderItem(item({ status: 'proposed', author: 'Readiness planner' }), ctx))
      .toBe('N1 [Decide] Which store goes first?\n  Proposed by Readiness planner, not yet triaged');
    expect(renderItem(item({ status: 'decided_by_overseer', decidedChoice: 'the first store', reason: 'it has the fewest products' }), ctx))
      .toBe('N1 [Decide] Which store goes first?\n  Decided by overseer: the first store. Reason: it has the fewest products');
  });

  it('an open item: kind, text, age, details, and "Proposed by …, not approved"', () => {
    expect(renderItem(item({ recommendation: 'the first store', options: [{ label: 'A', effect: 'a' }, { label: 'B', effect: 'b' }], blocks: 'the import agent' }), ctx)).toBe(
      'N1 [Decide] Which store goes first? (open 2h)\n' +
      '  Recommendation: the first store\n' +
      '  Options: A | B\n' +
      '  Blocks: the import agent\n' +
      '  Proposed by overseer, not approved',
    );
  });

  it('an answered go item: "You approved: <text> → <quote> (Mon 16:51)" plus the reading line', () => {
    expect(renderItem(item({ seq: 12, kind: 'go', text: 'Merge PR #12.', status: 'answered', quote: 'merge N12', quoteAt: AT, reading: 'merge only, no release' }), ctx)).toBe(
      'N12 [Go] Merge PR #12.\n' +
      '  You approved: "Merge PR #12." → "merge N12" (Mon 16:51)\n' +
      '  I read this as: merge only, no release',
    );
  });

  it('a statement: "You said: <quote> (Mon 16:51)"', () => {
    expect(renderItem(item({ seq: 3, kind: 'statement', text: 'never touch the archive table', author: 'you', status: 'answered', quote: 'never touch the archive table', quoteAt: AT }), ctx))
      .toBe('N3 You said: "never touch the archive table" (Mon 16:51)');
  });

  it('an imported item without a checked quote says "Imported, not checked"', () => {
    expect(renderItem(item({ origin: 'imported' }), ctx)).toBe('N1 [Decide] Which store goes first? (open 2h)\n  Imported, not checked');
    expect(renderItem(item({ origin: 'imported', status: 'answered' }), ctx)).toBe('N1 [Decide] Which store goes first?\n  Imported, not checked');
    expect(renderItem(item({ origin: 'imported', kind: 'statement', status: 'answered', text: 'keep prices' }), ctx)).toBe('N1 [Statement] keep prices\n  Imported, not checked');
  });

  it('a withdrawn or superseded imported item shows its terminal status first, then "Imported, not checked"', () => {
    expect(renderItem(item({ origin: 'imported', status: 'withdrawn', reason: 'the import was wrong' }), ctx)).toBe(
      'N1 [Decide] Which store goes first?\n  Withdrawn by overseer: the import was wrong\n  Imported, not checked',
    );
    expect(renderItem(item({ origin: 'imported', status: 'superseded' }), ctx)).toBe(
      'N1 [Decide] Which store goes first?\n  Superseded, not approved\n  Imported, not checked',
    );
  });

  it('withdrawn, parked, and a superseding item that shows the original question', () => {
    expect(renderItem(item({ status: 'withdrawn', reason: 'the agent found a built-in option' }), ctx))
      .toBe('N1 [Decide] Which store goes first?\n  Withdrawn by overseer: the agent found a built-in option');
    expect(renderItem(item({ status: 'parked', quote: 'later', quoteAt: AT }), ctx))
      .toBe('N1 [Decide] Which store goes first?\n  Parked by you: "later" (Mon 16:51)');
    const original = item({ seq: 3, text: 'Set the first store to Draft?', status: 'superseded' });
    const wider = item({ seq: 4, text: 'Also set the second store to Draft?', supersedes: 3 });
    expect(renderItem(wider, { ...ctx, lookup: (s) => (s === 3 ? original : null) })).toBe(
      'N4 [Decide] Also set the second store to Draft? (open 2h)\n' +
      '  Original question (N3): "Set the first store to Draft?"\n' +
      '  Proposed by overseer, not approved',
    );
  });
});

describe('renderLedgerSections', () => {
  const items = [
    item({ seq: 1, kind: 'go', text: 'Merge PR #12.' }),
    item({ seq: 2, kind: 'do', text: 'Check the banner on staging.' }),
    item({ seq: 3, kind: 'decide', text: 'Use library A?', status: 'answered', quote: 'A', quoteAt: AT, updatedAt: AT }),
    item({ seq: 4, kind: 'decide', text: 'Rename the CLI?', status: 'parked', quote: 'later', quoteAt: AT, updatedAt: AT }),
    item({ seq: 5, kind: 'decide', text: 'Old question?', status: 'answered', quote: 'yes', quoteAt: '2026-10-04T10:00:00.000Z', updatedAt: '2026-10-04T10:00:00.000Z' }),
  ];

  it('renders the #62 sections in order (now with cards), with decided items only since the last recap', () => {
    expect(renderLedgerSections(items, { now: NOW, lastRecapAt: '2026-10-05T12:00:00.000Z', timeZone: 'UTC' })).toBe(
      'Needs you now:\n' +
      '\n' +
      '**N1 · Go:** Merge PR #12.\n' +
      '\n' +
      'Holds up: nothing · Open 2 hours\n' +
      '\n' +
      '**Answer with:** `N1: merge`\n' +
      '\n' +
      'Running on defaults:\n- none\n' +
      '\n' +
      'Your tests and actions:\n' +
      '- N2 [Do] Check the banner on staging. (open 2h)\n' +
      '  Proposed by overseer, not approved\n' +
      '\n' +
      'Decided since the last recap:\n' +
      '- N3 [Decide] Use library A?\n' +
      '  You approved: "Use library A?" → "A" (Mon 16:51)\n' +
      '\n' +
      'Not yet triaged:\n- none\n' +
      '\n' +
      'Parked:\n' +
      '- N4 [Decide] Rename the CLI?\n' +
      '  Parked by you: "later" (Mon 16:51)\n' +
      '\n' +
      'Overseer decisions in the last 7 days: 0. Reversed by you: 0.',
    );
  });

  it('shows "- none" for an empty section and every decision when there was no recap yet', () => {
    const out = renderLedgerSections([items[4]], { now: NOW, lastRecapAt: null, timeZone: 'UTC' });
    expect(out).toContain('Needs you now:\n- none');
    expect(out).toContain('Decided since the last recap:\n- N5 [Decide] Old question?');
  });
});

describe('renderHandoffBlock', () => {
  it('starts with the fixed header and lists each item verbatim', () => {
    expect(renderHandoffBlock([item({ seq: 3, kind: 'decide', text: 'Use library A?', status: 'answered', quote: 'A', quoteAt: AT })], ctx)).toBe(
      'Owner decisions (verbatim, from the ledger):\n' +
      '- N3 [Decide] Use library A?\n' +
      '  You approved: "Use library A?" → "A" (Mon 16:51)',
    );
  });
});
