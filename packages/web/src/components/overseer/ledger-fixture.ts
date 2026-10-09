// A pinned card in the shape of real ledger rows, with generic text (the repository is public).
// Shared by the card, chip and draft tests.
import type { CardItem, LedgerCard } from '../../api/types';

export const NOW = Date.parse('2026-10-08T18:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;

export function cardItem(over: Partial<CardItem>): CardItem {
  return {
    seq: 1, kind: 'decide', status: 'open', text: 'Which store goes first?', author: 'overseer',
    context: null, options: [], recommendation: null, why: null, default: null, source: null,
    blocks: null, mission: null, origin: 'live', sentAt: ago(2 * 24 * HOUR), isNew: false,
    onDefaultSince: null, overseerNote: null, original: null,
    choice: null, quote: null, quoteAt: null, reason: null, reading: null,
    ...over,
  };
}

export const N14 = cardItem({
  seq: 14, text: 'How many clean nights before live mode?', author: 'Readiness planner', isNew: true, sentAt: ago(HOUR),
  context: 'The new sync runs in shadow mode. It computes changes but does not write them. Live mode lets it write. ' +
    'This sets how much clean history we need first. The weekend runs are the known risk, because the load pattern changes on Saturday.',
  options: [
    { label: 'A. 5 nights', effect: 'Live mode on Oct 14 at the earliest. Covers one weekend.', answerKey: 'A' },
    { label: 'B. 10 nights', effect: 'Oct 19. Covers two weekends.', answerKey: 'B' },
  ],
  recommendation: 'A. 5 nights', why: 'The weekend pattern is the known risk; 5 nights cover one weekend.',
  default: 'Nothing switches; the shadow run continues.', blocks: 'the switch to live mode',
  source: { kind: 'agent', ref: 'Readiness planner', path: 'docs/plans/readiness.md', section: 'Owner decisions', id: 'LR-6' },
  overseerNote: 'The planner did not know about the holiday freeze.',
});

export const N12 = cardItem({
  seq: 12, kind: 'go', text: 'Merge PR #62 into main?', sentAt: ago(3 * HOUR),
  context: 'The recap PR is reviewed and CI is green.', default: 'Nothing happens.',
  source: { kind: 'pr', ref: '#62', path: null, section: null, id: null },
});

export const N9 = cardItem({ seq: 9, text: 'Keep or drop the old tag check?', recommendation: 'B. drop', options: [
  { label: 'A. keep', effect: 'Nothing changes.', answerKey: 'A' }, { label: 'B. drop', effect: 'One check less per run.', answerKey: 'B' },
] });

export const FIXTURE: LedgerCard = {
  updatedAt: ago(5 * 60_000),
  lastRecapAt: ago(24 * HOUR),
  sections: {
    rulesCount: 1,
    needsYou: { cards: [N14, N12], lines: [N9] },
    onDefaults: [cardItem({ seq: 5, text: 'Abort the import when duplicates pass 1%?', default: 'abort above 1%', onDefaultSince: '2026-10-01T09:00:00.000Z' })],
    actions: [
      cardItem({ seq: 20, kind: 'do', text: 'Check the banner on staging.', isNew: true }),
      cardItem({ seq: 21, kind: 'do', text: 'Rotate the test key.', origin: 'imported' }),
    ],
    decidedSince: [
      cardItem({ seq: 3, text: 'Use library A?', status: 'answered', quote: 'N3: A' }),
      cardItem({ seq: 8, kind: 'do', text: 'Drop the old flag.', status: 'withdrawn', reason: 'moot' }),
      cardItem({ seq: 4, text: 'Which retry helper?', status: 'decided_by_overseer', choice: 'the existing one', reason: 'it covers this case' }),
    ],
    untriaged: [cardItem({ seq: 30, text: 'Which day does the switch happen?', status: 'proposed', author: 'Readiness planner', sentAt: null })],
    parked: [cardItem({ seq: 2, text: 'Rename the CLI?', status: 'parked', quote: 'later' })],
    counts: { overseerDecisions: 1, reversed: 0 },
  },
  rules: [{ seq: 1, quote: 'never deploy on Fridays', reading: null }],
  index: [
    { seq: 1, kind: 'statement', status: 'answered', text: 'never deploy on Fridays', answer: 'never deploy on Fridays' },
    { seq: 2, kind: 'decide', status: 'parked', text: 'Rename the CLI?', answer: 'later' },
    { seq: 3, kind: 'decide', status: 'answered', text: 'Use library A?', answer: 'N3: A' },
    { seq: 4, kind: 'decide', status: 'decided_by_overseer', text: 'Which retry helper?', answer: 'the existing one' },
    { seq: 5, kind: 'decide', status: 'open', text: 'Abort the import when duplicates pass 1%?', answer: null },
    { seq: 8, kind: 'do', status: 'withdrawn', text: 'Drop the old flag.', answer: null },
    { seq: 9, kind: 'decide', status: 'open', text: 'Keep or drop the old tag check?', answer: null },
    { seq: 12, kind: 'go', status: 'open', text: 'Merge PR #62 into main?', answer: null },
    { seq: 14, kind: 'decide', status: 'open', text: 'How many clean nights before live mode?', answer: null },
    { seq: 20, kind: 'do', status: 'open', text: 'Check the banner on staging.', answer: null },
    { seq: 21, kind: 'do', status: 'open', text: 'Rotate the test key.', answer: null },
    { seq: 30, kind: 'decide', status: 'proposed', text: 'Which day does the switch happen?', answer: null },
    // Answered long ago: in the index, not on the card.
    { seq: 40, kind: 'decide', status: 'answered', text: 'Use the staging bucket for the export test?', answer: 'yes, N40: A' },
  ],
};

export const EMPTY_CARD: LedgerCard = {
  updatedAt: null, lastRecapAt: null,
  sections: {
    rulesCount: 0, needsYou: { cards: [], lines: [] }, onDefaults: [], actions: [], decidedSince: [],
    untriaged: [], parked: [], counts: { overseerDecisions: 0, reversed: 0 },
  },
  rules: [], index: [],
};
