// Card fields that pass every Unit 2 check (decision cards spec 2026-10-06), for tests that add
// go or decide items but test something else. Each has a title too, as ledger_add and an open
// imported item require one (titles spec 2026-10-09, Unit 2); a test that checks a title sets its own.
export const CONTEXT = 'The new sync runs in shadow mode. It computes changes but does not write them.';

export const DECIDE_CARD = {
  title: 'Clean nights before live mode',
  context: CONTEXT,
  options: [
    { label: 'A. 5 nights', effect: 'Live mode on Oct 14 at the earliest. Covers one weekend.' },
    { label: 'B. 10 nights', effect: 'Oct 19. Covers two weekends.' },
  ],
  recommendation: 'A. 5 nights',
  why: 'The weekend pattern is the known risk; 5 nights cover one weekend.',
  default: 'Nothing switches; the shadow run continues.',
  source: { kind: 'overseer' },
} as const;

export const GO_CARD = {
  title: 'Merge the reviewed fix',
  context: 'The fix is reviewed and CI is green on the branch.',
  default: 'Nothing happens.',
  source: { kind: 'overseer' },
} as const;

/** A valid owner-decisions entry, as a planner writes it (the spec's example). */
export const LR6 = {
  id: 'LR-6',
  kind: 'decide',
  question: 'How many clean nights before live mode?',
  context: 'The new sync runs in shadow mode. It computes changes but does not write them. Live mode lets it write. This sets how much clean history we need first.',
  options: [
    { label: 'A. 5 nights', effect: 'Live mode on Oct 14 at the earliest. Covers one weekend.' },
    { label: 'B. 10 nights', effect: 'Oct 19. Covers two weekends.' },
  ],
  recommendation: 'A. 5 nights',
  why: 'The weekend pattern is the known risk; 5 nights cover one weekend.',
  default: 'Nothing switches; the shadow run continues.',
  where: { path: 'docs/plans/readiness.md', section: 'Owner decisions' },
};
