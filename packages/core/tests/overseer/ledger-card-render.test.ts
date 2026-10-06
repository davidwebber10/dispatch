// The decision card, the one-line forms and the recap sections (decision cards spec 2026-10-06, Unit 5).
import { describe, it, expect } from 'vitest';
import { parseOptions, type LedgerItem } from '../../src/db/ledger.js';
import { renderCard, renderOneLine, renderDefaultLine, renderOverseerDecisionLine, renderCountLine, renderLedgerSections } from '../../src/overseer/ledger-render.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-06T18:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const ctx = { now: NOW, timeZone: 'UTC' };

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

const N14 = item({
  seq: 14, text: 'How many clean nights before live mode?', author: 'Readiness planner', blocks: 'the switch to live mode',
  context: 'The new sync runs in shadow mode. It computes changes but does not write them. Live mode lets it write. This sets how much clean history we need first.',
  options: [
    { label: 'A. 5 nights', effect: 'Live mode on Oct 14 at the earliest. Covers one weekend.' },
    { label: 'B. 10 nights', effect: 'Oct 19. Covers two weekends.' },
  ],
  recommendation: 'A. 5 nights', recommendationWhy: 'The weekend pattern is the known risk; 5 nights cover one weekend.',
  defaultText: 'Nothing switches; the shadow run continues.',
  sourceKind: 'agent', sourceRef: 'Readiness planner', sourceSection: 'docs/plans/readiness.md#Owner decisions', sourceId: 'LR-6',
  agentTerminalId: 'agent-1', agentDecisionId: 'LR-6', overseerNote: 'The planner did not know about the holiday freeze.',
});

describe('the full card', () => {
  it('renders the spec layout: each field its own paragraph, the option table, the recommended option marked', () => {
    expect(renderCard(N14, ctx)).toBe([
      '**N14 · Decide:** How many clean nights before live mode?',
      'Holds up: the switch to live mode · Open 2 days · Source: plan `docs/plans/readiness.md`, section "Owner decisions" (`LR-6`), from agent "Readiness planner"',
      '**Context:** The new sync runs in shadow mode. It computes changes but does not write them. Live mode lets it write. This sets how much clean history we need first.',
      '| Option | Effect |\n|---|---|\n| **A. 5 nights (recommended)** | Live mode on Oct 14 at the earliest. Covers one weekend. |\n| B. 10 nights | Oct 19. Covers two weekends. |',
      '**Why A. 5 nights:** The weekend pattern is the known risk; 5 nights cover one weekend.',
      '**If you do not answer:** Nothing switches; the shadow run continues.',
      "**Overseer's note:** The planner did not know about the holiday freeze.",
      '**Answer with:** `N14: A`, or your own words.',
    ].join('\n\n'));
  });

  it('a blank line separates every field, so markdown never joins two of them', () => {
    const paragraphs = renderCard(N14, ctx).split('\n\n');
    expect(paragraphs).toHaveLength(8);
    for (const p of paragraphs.filter((x) => !x.startsWith('|'))) expect(p).not.toContain('\n');
  });

  it('a go card uses "· Go:", shows no table without options, and ends with the named approval', () => {
    const go = item({ seq: 12, kind: 'go', text: 'Merge PR #62 into main?', context: 'The recap PR is reviewed and CI is green.', defaultText: 'Nothing happens.', sourceKind: 'pr', sourceRef: '#62', sentAt: ago(3 * 3_600_000) });
    expect(renderCard(go, ctx)).toBe([
      '**N12 · Go:** Merge PR #62 into main?',
      'Holds up: nothing · Open 3 hours · Source: PR #62',
      '**Context:** The recap PR is reviewed and CI is green.',
      '**If you do not answer:** Nothing happens.',
      '**Answer with:** `N12: merge`',
    ].join('\n\n'));
    expect(renderCard(item({ seq: 5, kind: 'go', text: 'Deploy v2.43 to this Mac?' }), ctx)).toContain('**Answer with:** `N5: deploy`');
    expect(renderCard(item({ seq: 5, kind: 'go', text: 'Ship the banner?' }), ctx)).toContain('**Answer with:** `N5: approve`');
  });

  it('a go card with options shows the table', () => {
    const go = item({ seq: 12, kind: 'go', text: 'Merge PR #62?', options: [{ label: 'merge now', effect: 'ships today' }], recommendation: 'merge now', recommendationWhy: 'it is green' });
    expect(renderCard(go, ctx)).toContain('| **merge now (recommended)** | ships today |');
  });

  it('each source kind', () => {
    const src = (over: Partial<LedgerItem>) => renderCard(item(over), ctx).split('\n\n')[1];
    expect(src({ sourceKind: 'plan', sourceRef: 'docs/plans/a.md', sourceSection: 'Risks', sourceId: 'D3' })).toContain('Source: plan `docs/plans/a.md`, section "Risks" (`D3`)');
    expect(src({ sourceKind: 'doc', sourceRef: 'docs/notes.md' })).toMatch(/Source: doc `docs\/notes.md`$/);
    expect(src({ sourceKind: 'agent', sourceRef: 'Map researcher' })).toMatch(/Source: agent "Map researcher"$/);
    expect(src({ sourceKind: 'agent', sourceRef: 'Map researcher', agentTerminalId: 'a', sourceSection: 'docs/research/map.md', sourceId: 'Q2' }))
      .toMatch(/Source: doc `docs\/research\/map.md` \(`Q2`\), from agent "Map researcher"$/);
    expect(src({ sourceKind: 'agent', sourceRef: 'Map researcher', agentTerminalId: 'a', sourceId: 'Q2' })).toMatch(/Source: agent "Map researcher" \(`Q2`\)$/);
    expect(src({ sourceKind: 'issue', sourceRef: '#7' })).toMatch(/Source: issue #7$/);
    expect(src({ sourceKind: 'user', sourceRef: 'switch to live mode soon' })).toMatch(/Source: your words "switch to live mode soon"$/);
    expect(src({ sourceKind: 'overseer' })).toMatch(/Source: overseer$/);
  });

  it('an old #62 row (plain-string options, no card fields) still renders as a card', () => {
    const old = item({ seq: 3, recommendation: 'A', options: parseOptions('["A","B"]'), blocks: 'the import agent' });
    expect(renderCard(old, ctx)).toBe([
      '**N3 · Decide:** Which store goes first?',
      'Holds up: the import agent · Open 2 days',
      '| Option | Effect |\n|---|---|\n| **A (recommended)** |  |\n| B |  |',
      '**Recommended:** A',
      '**Answer with:** `N3: A`, or your own words.',
    ].join('\n\n'));
    expect(renderCard(item({ seq: 4 }), ctx)).toBe(
      '**N4 · Decide:** Which store goes first?\n\nHolds up: nothing · Open 2 days\n\n**Answer with:** `N4:` and your own words.',
    );
  });

  it('an imported, a superseding, a proposed, a closed and an on-default card', () => {
    expect(renderCard(item({ origin: 'imported' }), ctx).split('\n\n')[1]).toBe('Holds up: nothing · Open 2 days · Imported, not checked');
    const original = item({ seq: 3, text: 'Set the first store to Draft?', status: 'superseded' });
    expect(renderCard(item({ seq: 4, supersedes: 3 }), { ...ctx, lookup: (s) => (s === 3 ? original : null) }))
      .toContain('\n\n**Original question (N3):** "Set the first store to Draft?"\n\n');
    expect(renderCard(item({ status: 'proposed', sentAt: null }), ctx).split('\n\n')[1]).toBe('Holds up: nothing · Not yet triaged');
    const decided = renderCard(item({ status: 'decided_by_overseer', decidedChoice: 'the first store', reason: 'it is the smallest' }), ctx);
    expect(decided).toContain('Holds up: nothing · Decided by overseer');
    expect(decided).toContain('**Outcome:** Decided by overseer: the first store. Reason: it is the smallest');
    expect(decided).not.toContain('Answer with');
    expect(renderCard(item({ onDefaultSince: '2026-10-01T09:00:00.000Z' }), ctx).split('\n\n')[1]).toBe('Holds up: nothing · Open 2 days · Running on the default since Oct 1');
  });

  it('a pipe or a line break in a table cell cannot break the table', () => {
    const odd = item({ options: [{ label: 'A | B', effect: 'line one\nline two' }, { label: 'C', effect: 'c' }] });
    expect(renderCard(odd, ctx)).toContain('| A \\| B | line one line two |');
  });
});

describe('the one-line forms', () => {
  it('Needs you now', () => {
    const n17 = item({ seq: 17, text: 'Keep or drop the old tag check?', recommendation: 'drop', sourceId: 'LR-12' });
    expect(renderOneLine(n17)).toBe('- **N17 · Decide:** Keep or drop the old tag check? Recommended: drop. Holds up: nothing. (`LR-12`, type `show N17`)');
    expect(renderOneLine(item({ seq: 2, kind: 'go', text: 'Merge PR #9?', blocks: 'the release' }))).toBe('- **N2 · Go:** Merge PR #9? Holds up: the release. (type `show N2`)');
    expect(renderOneLine(item({ seq: 2, origin: 'imported' }))).toBe('- **N2 · Decide:** Which store goes first? Holds up: nothing. Imported, not checked. (type `show N2`)');
  });

  it('Running on defaults', () => {
    const n9 = item({ seq: 9, text: 'Abort when duplicates pass 1%?', defaultText: 'abort above 1%', recommendation: 'keep', onDefaultSince: '2026-10-01T09:00:00.000Z' });
    expect(renderDefaultLine(n9, ctx)).toBe('- **N9 · Decide:** Abort when duplicates pass 1%? Running on the default "abort above 1%" since Oct 1. Recommended: keep. (type `show N9`)');
    expect(renderDefaultLine({ ...n9, defaultText: 'Abort above 1%.' }, ctx)).toContain('Running on the default "Abort above 1%" since Oct 1.');
  });

  it('Decided by overseer', () => {
    const n21 = item({ seq: 21, text: 'Which retry helper?', status: 'decided_by_overseer', decidedChoice: 'the existing one', reason: 'it already covers this case' });
    expect(renderOverseerDecisionLine(n21)).toBe('- **N21 · Decided by overseer:** Which retry helper? → the existing one. Reason: it already covers this case. (Reply "reverse N21" to change it.)');
  });

  it('the count line counts the 7-day decisions and the reversals among them', () => {
    const items = [
      item({ seq: 1, status: 'decided_by_overseer', decidedAt: ago(1 * DAY) }),
      item({ seq: 2, status: 'answered', decidedAt: ago(2 * DAY), quote: 'use the other helper' }), // reversed by the user
      item({ seq: 3, status: 'decided_by_overseer', decidedAt: ago(8 * DAY) }), // too old
      item({ seq: 4, status: 'answered', quote: 'A' }), // the user's own answer, never decided by the overseer
    ];
    expect(renderCountLine(items, NOW)).toBe('Overseer decisions in the last 7 days: 2. Reversed by you: 1.');
    expect(renderCountLine([], NOW)).toBe('Overseer decisions in the last 7 days: 0. Reversed by you: 0.');
  });
});

describe('the recap sections', () => {
  const LAST = ago(1 * DAY);

  it('renders the eight parts in the spec order', () => {
    const items = [
      item({ seq: 1, kind: 'statement', text: 'never deploy on Fridays', author: 'you', status: 'answered', quote: 'never deploy on Fridays', quoteAt: ago(3 * DAY), updatedAt: ago(3 * DAY), policy: true }),
      item({ seq: 2, kind: 'go', text: 'Merge PR #62?', sentAt: ago(1_000) }),
      item({ seq: 3, text: 'Abort when duplicates pass 1%?', defaultText: 'abort above 1%', onDefaultSince: '2026-10-01T09:00:00.000Z' }),
      item({ seq: 4, kind: 'do', text: 'Check the banner on staging.' }),
      item({ seq: 5, text: 'Use library A?', status: 'answered', quote: 'A', quoteAt: ago(1_000), updatedAt: ago(1_000) }),
      item({ seq: 6, text: 'Which retry helper?', status: 'decided_by_overseer', decidedChoice: 'the existing one', reason: 'it covers this case', decidedAt: ago(1_000), updatedAt: ago(1_000) }),
      item({ seq: 7, text: 'How many nights?', status: 'proposed', author: 'Readiness planner', sentAt: null }),
      item({ seq: 8, text: 'Which day?', status: 'proposed', author: 'Readiness planner', sentAt: null }),
      item({ seq: 9, text: 'Rename the CLI?', status: 'parked', quote: 'later', quoteAt: ago(1_000) }),
    ];
    const out = renderLedgerSections(items, { now: NOW, lastRecapAt: LAST, timeZone: 'UTC' });
    const order = ['Project rules (your words):', 'Needs you now:', 'Running on defaults:', 'Your tests and actions:',
      'Decided since the last recap:', 'Not yet triaged:', 'Parked:', 'Overseer decisions in the last 7 days: 1. Reversed by you: 0.'];
    const at = order.map((h) => out.indexOf(h));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(out.endsWith('Overseer decisions in the last 7 days: 1. Reversed by you: 0.')).toBe(true);
    expect(out).toContain('Project rules (your words):\n- N1 You said: "never deploy on Fridays"');
    expect(out).toContain('Needs you now:\n\n**N2 · Go:** Merge PR #62?');
    expect(out).toContain('Running on defaults:\n- **N3 · Decide:** Abort when duplicates pass 1%? Running on the default "abort above 1%" since Oct 1.');
    expect(out).not.toContain('**N3 · Decide:** Abort when duplicates pass 1%?\n'); // not a card under Needs you now
    expect(out).toContain('Decided since the last recap:\n- N5 [Decide] Use library A?');
    expect(out).toContain('- **N6 · Decided by overseer:** Which retry helper? → the existing one.');
    expect(out).toContain('Not yet triaged:\n- 2 proposed decisions from "Readiness planner" (N7, N8).');
    expect(out).toContain('Parked:\n- N9 [Decide] Rename the CLI?');
  });

  it('leaves out Project rules when there are none, and shows "- none" for an empty section', () => {
    const out = renderLedgerSections([], { now: NOW, lastRecapAt: null, timeZone: 'UTC' });
    expect(out).toBe([
      'Needs you now:\n- none', 'Running on defaults:\n- none', 'Your tests and actions:\n- none',
      'Decided since the last recap:\n- none', 'Not yet triaged:\n- none', 'Parked:\n- none',
      'Overseer decisions in the last 7 days: 0. Reversed by you: 0.',
    ].join('\n\n'));
  });

  it('Needs you now: full cards for the new items plus the top 5 (holds up work first, then the oldest); one line for the rest', () => {
    const old = (seq: number, daysAgo: number, blocks: string | null = null) => item({ seq, text: `Question ${seq}?`, sentAt: ago(daysAgo * DAY), blocks });
    const items = [
      old(1, 9), old(2, 8), old(3, 7), old(4, 6), old(5, 5), old(6, 4),
      old(7, 3, 'the deploy'), // holds up work: ranks first despite its age
      old(8, 2),
      item({ seq: 9, text: 'Question 9?', sentAt: ago(1_000) }), // new since the last recap
      item({ seq: 10, text: 'Question 10?', status: 'open', sentAt: ago(2_000), createdAt: ago(3 * DAY) }), // moved from proposed to open after the recap
    ];
    const out = renderLedgerSections(items, { now: NOW, lastRecapAt: LAST, timeZone: 'UTC' });
    const cards = [...out.matchAll(/^\*\*N(\d+) · Decide:\*\*/gm)].map((m) => Number(m[1]));
    const lines = [...out.matchAll(/^- \*\*N(\d+) · Decide:\*\*/gm)].map((m) => Number(m[1]));
    expect(cards).toEqual([9, 10, 7, 1, 2, 3, 4]);
    expect(lines).toEqual([5, 6, 8]);
  });

  it('with no recap yet, every open decision is new and gets a card', () => {
    const items = Array.from({ length: 7 }, (_, i) => item({ seq: i + 1, text: `Question ${i + 1}?` }));
    const out = renderLedgerSections(items, { now: NOW, lastRecapAt: null, timeZone: 'UTC' });
    expect([...out.matchAll(/^\*\*N(\d+) · Decide:\*\*/gm)]).toHaveLength(7);
  });

  it('one proposed decision reads in the singular; groups follow the agents in seq order', () => {
    const items = [
      item({ seq: 1, status: 'proposed', author: 'B agent', sentAt: null }),
      item({ seq: 2, status: 'proposed', author: 'A agent', sentAt: null }),
      item({ seq: 3, status: 'proposed', author: 'B agent', sentAt: null }),
    ];
    expect(renderLedgerSections(items, { now: NOW, lastRecapAt: null, timeZone: 'UTC' }))
      .toContain('Not yet triaged:\n- 2 proposed decisions from "B agent" (N1, N3).\n- 1 proposed decision from "A agent" (N2).');
  });
});
