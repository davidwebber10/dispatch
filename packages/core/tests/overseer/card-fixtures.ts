// Card fields that pass every Unit 2 check (decision cards spec 2026-10-06), for tests that add
// go or decide items but test something else.
export const CONTEXT = 'The new sync runs in shadow mode. It computes changes but does not write them.';

export const DECIDE_CARD = {
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
  context: 'The fix is reviewed and CI is green on the branch.',
  default: 'Nothing happens.',
  source: { kind: 'overseer' },
} as const;
