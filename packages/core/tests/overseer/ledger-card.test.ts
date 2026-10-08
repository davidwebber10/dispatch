// The pinned card's JSON (pinned card spec 2026-10-08, Unit 2): the sections of Unit 1 as card items.
import { describe, it, expect } from 'vitest';
import type { LedgerItem } from '../../src/db/ledger.js';
import { answerKey, buildLedgerCard } from '../../src/overseer/ledger-card.js';

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

// The shape of a real agent-block row (generic text).
const N14 = item({
  seq: 14, text: 'How many clean nights before live mode?', author: 'Readiness planner', blocks: 'the switch to live mode',
  context: 'The new sync runs in shadow mode. It computes changes but does not write them. Live mode lets it write.',
  options: [
    { label: 'A. 5 nights', effect: 'Live mode on Oct 14 at the earliest. Covers one weekend.' },
    { label: 'B. 10 nights', effect: 'Oct 19. Covers two weekends.' },
  ],
  recommendation: 'A. 5 nights', recommendationWhy: 'The weekend pattern is the known risk; 5 nights cover one weekend.',
  defaultText: 'Nothing switches; the shadow run continues.', mission: 'Delta sync',
  sourceKind: 'agent', sourceRef: 'Readiness planner', sourceSection: 'docs/plans/readiness.md#Owner decisions', sourceId: 'LR-6',
  agentTerminalId: 'agent-1', agentDecisionId: 'LR-6', overseerNote: 'The planner did not know about the holiday freeze.',
  sentAt: ago(1_000), updatedAt: ago(1_000),
});

describe('answerKey', () => {
  it('is the leading token of one to three letters or digits and a full stop, else the whole label', () => {
    expect(answerKey('A. 5 nights')).toBe('A');
    expect(answerKey('B. 10 nights')).toBe('B');
    expect(answerKey('12. twelve')).toBe('12');
    expect(answerKey('ABC. three letters')).toBe('ABC');
    expect(answerKey('ABCD. four letters')).toBe('ABCD. four letters');
    expect(answerKey('merge now')).toBe('merge now');
    expect(answerKey('1.5 nights')).toBe('1.5 nights'); // a decimal, not a key
    expect(answerKey('A) 5 nights')).toBe('A) 5 nights');
    expect(answerKey('A')).toBe('A');
  });
});

describe('buildLedgerCard', () => {
  it('a decide item carries every field of the card', () => {
    const card = buildLedgerCard([N14], { now: NOW, lastRecapAt: LAST });
    expect(card.sections.needsYou.cards).toEqual([{
      seq: 14, kind: 'decide', status: 'open', text: 'How many clean nights before live mode?', author: 'Readiness planner',
      context: N14.context,
      options: [
        { label: 'A. 5 nights', effect: 'Live mode on Oct 14 at the earliest. Covers one weekend.', answerKey: 'A' },
        { label: 'B. 10 nights', effect: 'Oct 19. Covers two weekends.', answerKey: 'B' },
      ],
      recommendation: 'A. 5 nights', why: N14.recommendationWhy, default: 'Nothing switches; the shadow run continues.',
      // An agent-block source keeps the file and the section apart.
      source: { kind: 'agent', ref: 'Readiness planner', path: 'docs/plans/readiness.md', section: 'Owner decisions', id: 'LR-6' },
      blocks: 'the switch to live mode', mission: 'Delta sync', origin: 'live', sentAt: N14.sentAt, isNew: true,
      onDefaultSince: null, overseerNote: 'The planner did not know about the holiday freeze.', original: null,
      choice: null, quote: null, quoteAt: null, reason: null, reading: null,
    }]);
    expect(card.updatedAt).toBe(N14.updatedAt);
    expect(card.lastRecapAt).toBe(LAST);
  });

  it('every section, the rules and the index', () => {
    const items = [
      item({ seq: 1, kind: 'statement', text: 'never deploy on Fridays', author: 'you', status: 'answered', quote: 'never deploy on Fridays', reading: 'no release on a Friday either', policy: true }),
      item({ seq: 2, kind: 'go', text: 'Merge PR #62?' }),
      item({ seq: 3, text: 'Abort when duplicates pass 1%?', onDefaultSince: '2026-10-01T09:00:00.000Z' }),
      item({ seq: 4, kind: 'do', text: 'Check the banner on staging.' }),
      item({ seq: 5, text: 'Use library A?', status: 'answered', quote: 'N5: A', quoteAt: ago(1_000), updatedAt: ago(1_000) }),
      item({ seq: 6, text: 'Which retry helper?', status: 'decided_by_overseer', decidedChoice: 'the existing one', reason: 'it covers this case', decidedAt: ago(1_000), updatedAt: ago(1_000) }),
      item({ seq: 7, text: 'How many nights?', status: 'proposed', sentAt: null }),
      item({ seq: 8, text: 'Rename the CLI?', status: 'parked', quote: 'later' }),
      item({ seq: 9, text: 'Also set the second store to Draft?', supersedes: 7, sentAt: ago(1_000) }),
      item({ seq: 10, kind: 'do', text: 'Drop the old tag check.', status: 'withdrawn', reason: 'moot', updatedAt: ago(500) }),
    ];
    const card = buildLedgerCard(items, { now: NOW, lastRecapAt: LAST });
    const seqs = (list: { seq: number }[]) => list.map((i) => i.seq);
    expect(seqs(card.sections.needsYou.cards)).toEqual([9, 2]);
    expect(seqs(card.sections.onDefaults)).toEqual([3]);
    expect(seqs(card.sections.actions)).toEqual([4]);
    expect(seqs(card.sections.decidedSince)).toEqual([5, 10, 6]);
    expect(seqs(card.sections.untriaged)).toEqual([7]);
    expect(seqs(card.sections.parked)).toEqual([8]);
    expect(card.sections.rulesCount).toBe(1);
    expect(card.sections.counts).toEqual({ overseerDecisions: 1, reversed: 0 });
    // The superseding item names the original question.
    expect(card.sections.needsYou.cards[0].original).toEqual({ seq: 7, text: 'How many nights?' });
    // A decided item carries the choice and the quote or the reason.
    const decided = Object.fromEntries(card.sections.decidedSince.map((i) => [i.seq, i]));
    expect(decided[5]).toMatchObject({ quote: 'N5: A', choice: null });
    expect(decided[6]).toMatchObject({ choice: 'the existing one', reason: 'it covers this case' });
    expect(decided[10]).toMatchObject({ reason: 'moot' });
    expect(card.rules).toEqual([{ seq: 1, quote: 'never deploy on Fridays', reading: 'no release on a Friday either' }]);
    expect(card.index).toEqual([
      { seq: 1, kind: 'statement', status: 'answered', text: 'never deploy on Fridays', answer: 'never deploy on Fridays' },
      { seq: 2, kind: 'go', status: 'open', text: 'Merge PR #62?', answer: null },
      { seq: 3, kind: 'decide', status: 'open', text: 'Abort when duplicates pass 1%?', answer: null },
      { seq: 4, kind: 'do', status: 'open', text: 'Check the banner on staging.', answer: null },
      { seq: 5, kind: 'decide', status: 'answered', text: 'Use library A?', answer: 'N5: A' },
      { seq: 6, kind: 'decide', status: 'decided_by_overseer', text: 'Which retry helper?', answer: 'the existing one' },
      { seq: 7, kind: 'decide', status: 'proposed', text: 'How many nights?', answer: null },
      { seq: 8, kind: 'decide', status: 'parked', text: 'Rename the CLI?', answer: 'later' },
      { seq: 9, kind: 'decide', status: 'open', text: 'Also set the second store to Draft?', answer: null },
      { seq: 10, kind: 'do', status: 'withdrawn', text: 'Drop the old tag check.', answer: null },
    ]);
    // updatedAt is the newest change of any item.
    expect(card.updatedAt).toBe(ago(500));
  });

  it('isNew follows Unit 1, for decide, go and do items', () => {
    const card = buildLedgerCard([
      item({ seq: 1, kind: 'do', text: 'Check staging.', sentAt: ago(1_000) }),
      item({ seq: 2, kind: 'go', text: 'Merge PR #9?', sentAt: ago(1_000), origin: 'imported' }),
    ], { now: NOW, lastRecapAt: LAST });
    expect(card.sections.actions[0].isNew).toBe(true);
    expect(card.sections.needsYou.cards[0].isNew).toBe(false);
  });

  it('the sources in their plain forms; options of an old row read as an empty effect', () => {
    const src = (over: Partial<LedgerItem>) => buildLedgerCard([item(over)], { now: NOW, lastRecapAt: LAST }).sections.needsYou.cards[0].source;
    expect(src({ sourceKind: 'plan', sourceRef: 'docs/plans/a.md', sourceSection: 'Risks', sourceId: 'D3' }))
      .toEqual({ kind: 'plan', ref: 'docs/plans/a.md', path: null, section: 'Risks', id: 'D3' });
    expect(src({ sourceKind: 'agent', sourceRef: 'Map researcher', sourceSection: 'Q2 part' }))
      .toEqual({ kind: 'agent', ref: 'Map researcher', path: null, section: 'Q2 part', id: null });
    expect(src({ sourceKind: 'agent', sourceRef: 'Map researcher', agentTerminalId: 'a', sourceSection: '#Findings' }))
      .toEqual({ kind: 'agent', ref: 'Map researcher', path: null, section: 'Findings', id: null });
    expect(src({ sourceKind: 'pr', sourceRef: '#12' })).toEqual({ kind: 'pr', ref: '#12', path: null, section: null, id: null });
    expect(src({})).toBeNull();
    const old = buildLedgerCard([item({ options: [{ label: 'A', effect: '' }, { label: 'B', effect: '' }] })], { now: NOW, lastRecapAt: LAST });
    expect(old.sections.needsYou.cards[0].options).toEqual([{ label: 'A', effect: '', answerKey: 'A' }, { label: 'B', effect: '', answerKey: 'B' }]);
  });

  it('an empty ledger: empty sections, no rules, an empty index and no update time', () => {
    expect(buildLedgerCard([], { now: NOW, lastRecapAt: null })).toEqual({
      updatedAt: null, lastRecapAt: null,
      sections: {
        rulesCount: 0, needsYou: { cards: [], lines: [] }, onDefaults: [], actions: [], decidedSince: [],
        untriaged: [], parked: [], counts: { overseerDecisions: 0, reversed: 0 },
      },
      rules: [], index: [],
    });
  });
});
