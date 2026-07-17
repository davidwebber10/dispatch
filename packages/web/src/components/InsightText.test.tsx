import { test, expect } from 'vitest';
import { splitInsights } from './InsightText';

// Box-drawing dash (U+2500) — the exact character Claude uses for the ★ Insight delimiter rules.
const D = '─────';

test('detects a backtick-wrapped ★ Insight block (Claude fences the delimiter lines as inline code)', () => {
  // The real failing case: Claude emits the opener/closer as inline code, e.g. `★ Insight ───`.
  const input = 'intro\n\n`★ Insight ' + D + '`\n- a\n- b\n`' + D + '`\n\nouttro';
  expect(splitInsights(input)).toEqual([
    // The blank gap before/after the callout rides along as a trailing/leading newline.
    { type: 'md', content: 'intro\n' },
    { type: 'insight', content: '- a\n- b' },
    { type: 'md', content: '\nouttro' },
  ]);
});

test('still detects a plain (un-backticked) ★ Insight block — coordinator surface regression', () => {
  const input = 'before\n\n★ Insight ' + D + '\n- x\n- y\n' + D + '\n\nafter';
  expect(splitInsights(input)).toEqual([
    { type: 'md', content: 'before\n' },
    { type: 'insight', content: '- x\n- y' },
    { type: 'md', content: '\nafter' },
  ]);
});

test('prose with no insight delimiter yields a single md segment', () => {
  const input = 'just some prose\n\nwith two paragraphs';
  expect(splitInsights(input)).toEqual([{ type: 'md', content: input }]);
});
