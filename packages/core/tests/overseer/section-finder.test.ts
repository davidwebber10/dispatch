// The section finder (titles and source panel spec 2026-10-09, Unit 6): pure functions that find the
// plan section an item comes from, or give the outline. Plan text here is generic.
import { describe, it, expect } from 'vitest';
import { findSection, markdownHeadings, normalizeHeading, SECTION_MAX_BYTES } from '../../src/overseer/section-finder.js';

const PLAN = [
  '# Example plan',
  '',
  'Intro text.',
  '',
  '## Background',
  '',
  'Some history.',
  '',
  '## Open owner decisions after v3.2 (the v3 table, updated 2026-10-08)',
  '',
  '| ID | Question | Recommendation |',
  '|---|---|---|',
  '| LR-6 | How many clean nights before live mode? | A. 5 nights |',
  '| LR-7 | Which day does the switch happen? | Monday |',
  '',
  '### Notes on LR-6',
  '',
  'The weekend runs are the known risk.',
  '',
  '## Risks',
  '',
  '- The load pattern changes on Saturday.',
  '',
  '# Appendix',
  '',
  'More.',
].join('\n');

describe('markdownHeadings', () => {
  it('ATX headings only, with their level; the closing #s go; "#tag" is not a heading', () => {
    const md = '# One #\n#tag\n  ## Two ##  \n####### seven\n###### Six\nText\n===\n';
    expect(markdownHeadings(md).map(({ level, text }) => ({ level, text }))).toEqual([
      { level: 1, text: 'One' }, { level: 2, text: 'Two' }, { level: 6, text: 'Six' },
    ]);
  });

  it('ignores headings inside fenced code blocks (backticks and tildes)', () => {
    const md = '# Real\n```md\n# Not a heading\n```\n~~~~\n## Nor this\n~~~\n## Still in the fence\n~~~~\n## Real two\n';
    expect(markdownHeadings(md).map((h) => h.text)).toEqual(['Real', 'Real two']);
  });
});

describe('normalizeHeading', () => {
  it('lower case, no emphasis or code marks, spaces collapsed, no end punctuation', () => {
    expect(normalizeHeading('  **Open**   owner `decisions`:  ')).toBe('open owner decisions');
    expect(normalizeHeading('_Risks_.')).toBe('risks');
    expect(normalizeHeading('What next?!')).toBe('what next');
  });
});

describe('findSection', () => {
  it('an exact match: the heading and the markdown up to the next heading of the same or a higher level', () => {
    const out = findSection(PLAN, { section: 'Risks' });
    expect(out).toEqual({ kind: 'section', heading: 'Risks', level: 2, markdown: '- The load pattern changes on Saturday.', cut: false });
  });

  it('a heading that starts with the stored name: "after v3" finds "after v3.2 (…)"; a deeper heading stays inside', () => {
    const out = findSection(PLAN, { section: 'Open owner decisions after v3', id: 'LR-6' });
    expect(out.kind).toBe('section');
    if (out.kind !== 'section') return;
    expect(out.heading).toBe('Open owner decisions after v3.2 (the v3 table, updated 2026-10-08)');
    expect(out.markdown.startsWith('| ID | Question | Recommendation |')).toBe(true);
    expect(out.markdown).toContain('### Notes on LR-6');
    expect(out.markdown.endsWith('The weekend runs are the known risk.')).toBe(true);
    expect(out.markdown).not.toContain('Risks');
  });

  it('a stored name that starts with the heading; then a heading that contains the stored name', () => {
    expect(findSection(PLAN, { section: 'Background and scope' })).toMatchObject({ kind: 'section', heading: 'Background' });
    expect(findSection(PLAN, { section: 'owner decisions' })).toMatchObject({ kind: 'section', heading: 'Open owner decisions after v3.2 (the v3 table, updated 2026-10-08)' });
  });

  it('the steps go in order, and the first heading in the file wins at each step', () => {
    const md = '## Risks and costs\nA\n## Risks\nB\n## Risks\nC\n';
    expect(findSection(md, { section: 'Risks' })).toMatchObject({ heading: 'Risks', markdown: 'B' }); // exact beats the earlier prefix match
    expect(findSection(md, { section: 'risks and' })).toMatchObject({ heading: 'Risks and costs', markdown: 'A' });
  });

  it('a heading that contains the ID as a whole word, when no heading matches the name', () => {
    const md = '## Notes on LR-60\nx\n## Notes on LR-6\ny\n';
    expect(findSection(md, { section: 'Owner decisions', id: 'LR-6' })).toMatchObject({ heading: 'Notes on LR-6', markdown: 'y' });
    expect(findSection(md, { section: 'Owner decisions', id: 'lr-6' })).toMatchObject({ heading: 'Notes on LR-6' });
  });

  it('no match, or no stored section: the outline, every heading with its level', () => {
    const outline = { kind: 'outline', headings: [
      { level: 1, text: 'Example plan' }, { level: 2, text: 'Background' },
      { level: 2, text: 'Open owner decisions after v3.2 (the v3 table, updated 2026-10-08)' },
      { level: 3, text: 'Notes on LR-6' }, { level: 2, text: 'Risks' }, { level: 1, text: 'Appendix' },
    ] };
    expect(findSection(PLAN, { section: 'Rollout steps', id: 'Q99' })).toEqual(outline);
    expect(findSection(PLAN, { section: '', id: 'LR-6' })).toEqual(outline);
    expect(findSection(PLAN, { section: null })).toEqual(outline);
  });

  it('a heading inside a code block neither matches nor ends a section', () => {
    const md = '## Steps\none\n```\n## Risks\n```\ntwo\n## Risks\nthree\n';
    expect(findSection(md, { section: 'Risks' })).toMatchObject({ heading: 'Risks', markdown: 'three' });
    expect(findSection(md, { section: 'Steps' })).toMatchObject({ markdown: 'one\n```\n## Risks\n```\ntwo' });
  });

  it('a section longer than 64 KB is cut at a line end', () => {
    expect(SECTION_MAX_BYTES).toBe(64 * 1024);
    const row = `| LR-1 | ${'x'.repeat(90)} |`; // 99 bytes
    const md = `## Big\n${Array.from({ length: 1000 }, () => row).join('\n')}\n## After\n`;
    const out = findSection(md, { section: 'Big' });
    expect(out.kind).toBe('section');
    if (out.kind !== 'section') return;
    expect(out.cut).toBe(true);
    expect(Buffer.byteLength(out.markdown)).toBeLessThanOrEqual(SECTION_MAX_BYTES);
    expect(out.markdown.split('\n').every((l) => l === row)).toBe(true);
    expect(out.markdown.split('\n')).toHaveLength(Math.floor((SECTION_MAX_BYTES + 1) / (row.length + 1)));
  });

  it('a heading input (an outline click) selects that exact heading', () => {
    expect(findSection(PLAN, { section: 'Risks', heading: 'Background' })).toMatchObject({ heading: 'Background', markdown: 'Some history.' });
    expect(findSection(PLAN, { heading: 'Notes on LR-6' })).toMatchObject({ heading: 'Notes on LR-6', level: 3, markdown: 'The weekend runs are the known risk.' });
    expect(findSection(PLAN, { heading: 'Gone' }).kind).toBe('outline');
  });

  it('Windows line ends read the same', () => {
    expect(findSection('## Risks\r\nA risk.\r\n## Next\r\n', { section: 'Risks' })).toMatchObject({ heading: 'Risks', markdown: 'A risk.' });
  });
});

// Review round 1 (2026-10-09): a fence that opens inside a list item, and the section number.
describe('review round 1 — list-item fences and section numbers', () => {
  it('a fence that opens after a list marker hides its heading-like lines, and its indented closer ends it', () => {
    const md = ['## Steps', '', '- ```md', '  ## Example', '  ```', '', '## Risks', '', 'A risk.'].join('\n');
    expect(markdownHeadings(md).map((h) => h.text)).toEqual(['Steps', 'Risks']);
    expect(findSection(md, { section: 'Risks' })).toMatchObject({ heading: 'Risks', markdown: 'A risk.' });
    const ordered = ['1. ~~~', '   # Not a heading', '   ~~~', '# Real'].join('\n');
    expect(markdownHeadings(ordered).map((h) => h.text)).toEqual(['Real']);
  });

  it('review round 2: a list line with a fence inside a fenced markdown example does not close it', () => {
    const md = ['## Guide', '', '~~~markdown', '- ~~~', '## Example inside', '~~~', '', '## Real', '', 'text'].join('\n');
    expect(markdownHeadings(md).map((h) => h.text)).toEqual(['Guide', 'Real']);
    expect(findSection(md, { section: 'Real' })).toMatchObject({ heading: 'Real', markdown: 'text' });
  });

  it('as a last step, a stored "9. Owner decisions" finds the heading with the same section number', () => {
    const md = ['## 8. Release', '', 'x', '', '## 9. Decisions recorded (2026-10-09)', '', 'y', '', '## 9.1 Later', '', 'z'].join('\n');
    expect(findSection(md, { section: '9. Owner decisions' })).toMatchObject({ heading: '9. Decisions recorded (2026-10-09)' });
    expect(findSection(md, { section: '9.1 Something else' })).toMatchObject({ heading: '9.1 Later' });
    // "9" never matches "9.1", and a name without a number still gives the outline.
    expect(findSection(['## 9.1 Later', '', 'z'].join('\n'), { section: '9. Owner decisions' }).kind).toBe('outline');
    expect(findSection(md, { section: 'Owner decisions' }).kind).toBe('outline');
  });
});
