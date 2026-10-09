// The recap sections as data (pinned card spec 2026-10-08, Unit 1). renderLedgerSections is a text
// render of ledgerSections: its own tests (ledger-card-render.test.ts) pin the text; these pin the data.
import { describe, it, expect } from 'vitest';
import type { LedgerItem } from '../../src/db/ledger.js';
import { isNewForUser, ledgerSections, renderLedgerSections } from '../../src/overseer/ledger-render.js';

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

const seqs = (list: LedgerItem[]) => list.map((i) => i.seq);

// One item for every section, in the shape of real rows (generic text).
const ALL = [
  item({ seq: 1, kind: 'statement', text: 'never deploy on Fridays', author: 'you', status: 'answered', quote: 'never deploy on Fridays', quoteAt: ago(3 * DAY), updatedAt: ago(3 * DAY), policy: true }),
  item({ seq: 2, kind: 'go', text: 'Merge PR #62?', sentAt: ago(1_000) }),
  item({ seq: 3, text: 'Abort when duplicates pass 1%?', defaultText: 'abort above 1%', onDefaultSince: '2026-10-01T09:00:00.000Z' }),
  item({ seq: 4, kind: 'do', text: 'Check the banner on staging.' }),
  item({ seq: 5, text: 'Use library A?', status: 'answered', quote: 'A', quoteAt: ago(1_000), updatedAt: ago(1_000) }),
  item({ seq: 6, text: 'Which retry helper?', status: 'decided_by_overseer', decidedChoice: 'the existing one', reason: 'it covers this case', decidedAt: ago(1_000), updatedAt: ago(1_000), sentAt: null }),
  item({ seq: 7, text: 'How many nights?', status: 'proposed', author: 'Readiness planner', sentAt: null }),
  item({ seq: 8, text: 'Which day?', status: 'proposed', author: 'Readiness planner', sentAt: null }),
  item({ seq: 9, text: 'Rename the CLI?', status: 'parked', quote: 'later', quoteAt: ago(1_000) }),
  item({ seq: 10, kind: 'do', text: 'Drop the old tag check.', status: 'withdrawn', reason: 'moot', updatedAt: ago(500) }),
  item({ seq: 11, kind: 'do', text: 'Rotate the test key.', sentAt: ago(2_000) }),
];

describe('ledgerSections', () => {
  it('returns every section of the recap as data, in the order renderLedgerSections prints them', () => {
    const s = ledgerSections(ALL, { now: NOW, lastRecapAt: LAST });
    expect(s.rulesCount).toBe(1);
    expect(seqs(s.needsYou.cards)).toEqual([2]);
    expect(seqs(s.needsYou.lines)).toEqual([]);
    expect(seqs(s.onDefaults)).toEqual([3]);
    expect(seqs(s.actions)).toEqual([4, 11]);
    // The user's answers and withdrawals first, then the overseer's own decisions.
    expect(seqs(s.decidedSince)).toEqual([5, 10, 6]);
    expect(seqs(s.untriaged)).toEqual([7, 8]);
    expect(seqs(s.parked)).toEqual([9]);
    expect(s.counts).toEqual({ overseerDecisions: 1, reversed: 0 });
  });

  it('new: every open go, decide or do item sent after the last recap, never an imported one or one on a default', () => {
    const s = ledgerSections(ALL, { now: NOW, lastRecapAt: LAST });
    expect(s.newSeqs).toEqual([2, 11]);
    const imported = item({ seq: 12, kind: 'go', text: 'Deploy?', origin: 'imported', sentAt: ago(1_000) });
    expect(ledgerSections([...ALL, imported], { now: NOW, lastRecapAt: LAST }).newSeqs).toEqual([2, 11]);
    // With no recap yet, every open item is new — except an imported one and N3, which runs on its default.
    expect(ledgerSections([...ALL, imported], { now: NOW, lastRecapAt: null }).newSeqs).toEqual([2, 4, 11]);
  });

  it('isNewForUser: open, not imported, sent after the last recap', () => {
    expect(isNewForUser(item({ sentAt: ago(1_000) }), LAST)).toBe(true);
    expect(isNewForUser(item({ kind: 'do', sentAt: ago(1_000) }), LAST)).toBe(true);
    expect(isNewForUser(item({ sentAt: ago(2 * DAY) }), LAST)).toBe(false);
    expect(isNewForUser(item({ sentAt: ago(1_000), origin: 'imported' }), LAST)).toBe(false);
    expect(isNewForUser(item({ sentAt: ago(1_000), status: 'answered' }), LAST)).toBe(false);
    // Review round 1: marked to run on its default before the recap, it no longer waits on the user.
    expect(isNewForUser(item({ sentAt: ago(1_000), onDefaultSince: ago(500) }), LAST)).toBe(false);
    expect(isNewForUser(item({}), null)).toBe(true);
  });

  it('Needs you now: the new decisions first, then the top 5 of the rest (holds up work first, then the oldest); the rest as lines', () => {
    const old = (seq: number, daysAgo: number, blocks: string | null = null) => item({ seq, text: `Question ${seq}?`, sentAt: ago(daysAgo * DAY), blocks });
    const items = [
      old(1, 9), old(2, 8), old(3, 7), old(4, 6), old(5, 5), old(6, 4),
      old(7, 3, 'the deploy'),
      old(8, 2),
      item({ seq: 9, text: 'Question 9?', sentAt: ago(1_000) }),
      item({ seq: 10, text: 'Question 10?', sentAt: ago(2_000), createdAt: ago(3 * DAY) }),
    ];
    const s = ledgerSections(items, { now: NOW, lastRecapAt: LAST });
    expect(seqs(s.needsYou.cards)).toEqual([9, 10, 7, 1, 2, 3, 4]);
    expect(seqs(s.needsYou.lines)).toEqual([5, 6, 8]);
  });

  it('an empty ledger gives empty sections', () => {
    expect(ledgerSections([], { now: NOW, lastRecapAt: null })).toEqual({
      rulesCount: 0, needsYou: { cards: [], lines: [] }, onDefaults: [], actions: [], decidedSince: [],
      untriaged: [], parked: [], counts: { overseerDecisions: 0, reversed: 0 }, newSeqs: [],
    });
  });
});

describe('renderLedgerSections is a text render of ledgerSections', () => {
  it('each section of the text names exactly the items of the matching data section', () => {
    const s = ledgerSections(ALL, { now: NOW, lastRecapAt: LAST });
    const text = renderLedgerSections(ALL, { now: NOW, lastRecapAt: LAST, timeZone: 'UTC' });
    const part = (heading: string) => text.split('\n\n').filter((p) => p.startsWith(heading)).join('\n');
    const ids = (p: string) => [...new Set([...p.matchAll(/N(\d+)/g)].map((m) => Number(m[1])))];
    expect(ids(text.slice(text.indexOf('Needs you now:'), text.indexOf('Running on defaults:')))).toEqual(seqs([...s.needsYou.cards, ...s.needsYou.lines]));
    expect(ids(part('Running on defaults:'))).toEqual(seqs(s.onDefaults));
    expect(ids(part('Your tests and actions:'))).toEqual(seqs(s.actions));
    expect(ids(part('Decided since the last recap:'))).toEqual(seqs(s.decidedSince));
    expect(ids(part('Not yet triaged:'))).toEqual(seqs(s.untriaged));
    expect(ids(part('Parked:'))).toEqual(seqs(s.parked));
    expect(text).toContain(`Overseer decisions in the last 7 days: ${s.counts.overseerDecisions}. Reversed by you: ${s.counts.reversed}.`);
    expect(text.startsWith(`Project rules: ${s.rulesCount} in force`)).toBe(true);
  });
});
