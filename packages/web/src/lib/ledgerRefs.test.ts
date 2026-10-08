// Ledger chips (pinned card spec 2026-10-08, Unit 9): every known ledger number in Control Plane
// text carries its question; unknown numbers and code stay as they are.
import { describe, it, expect } from 'vitest';
import { chipifyHtml, chipLabel, splitLedgerRefs, type LedgerIndexEntry } from './ledgerRefs';

const entry = (seq: number, text: string): LedgerIndexEntry => ({ seq, kind: 'decide', status: 'open', text, answer: null });
const INDEX = new Map<number, LedgerIndexEntry>([
  [12, entry(12, 'Merge PR #62 into main?')],
  [14, entry(14, 'How many clean nights before live mode?')],
  [7, entry(7, 'Keep the <b>old</b> "tag" check & the <img src=x onerror=alert(1)> line?')],
]);
const known = (seq: number) => INDEX.has(seq);

describe('chipLabel', () => {
  it('the number and the question, cut at about 70 characters', () => {
    expect(chipLabel(14, 'How many clean nights before live mode?')).toBe('N14 · How many clean nights before live mode?');
    const long = 'Should the nightly export keep writing the old column next to the new one until every reader moved?';
    const label = chipLabel(3, long);
    expect(label.startsWith('N3 · Should the nightly export keep writing the old column')).toBe(true);
    expect(label.endsWith('…')).toBe(true);
    expect(label.length).toBeLessThanOrEqual('N3 · '.length + 71);
  });
});

describe('splitLedgerRefs — plain text', () => {
  it('known numbers become refs; unknown ones stay text', () => {
    expect(splitLedgerRefs('N14: A, and N99 later. N12 too', known)).toEqual([
      { seq: 14 }, ': A, and N99 later. ', { seq: 12 }, ' too',
    ]);
  });

  it('a ledger number is a whole word: N12a, AN12 and N123 are not N12', () => {
    expect(splitLedgerRefs('N12a AN12 N123 xN12 N12', known)).toEqual(['N12a AN12 N123 xN12 ', { seq: 12 }]);
  });

  it('never inside a code span or a code block', () => {
    expect(splitLedgerRefs('run `show N14` then N14', known)).toEqual(['run `show N14` then ', { seq: 14 }]);
    expect(splitLedgerRefs('```\nN12: merge\n```\nN12', known)).toEqual(['```\nN12: merge\n```\n', { seq: 12 }]);
  });

  // Review round 1: a number in a URL or a path is part of the address, not a ledger number.
  it('no chip in a URL or a path context', () => {
    const none = [
      'see https://example.com/N14 now', 'docs/plans/N12-design.md', 'C:\\work\\N12', 'page#N14', 'x?id=N14', 'a=N14&b=2',
      'N14.md', 'N14/notes', 'N14-N16', 'N14://host', 'v1.N12', 'LR-N14', 'N12\\x',
    ];
    for (const text of none) expect(splitLedgerRefs(text, known), text).toEqual([text]);
  });

  it('a sentence around the number is no path: the chip stays', () => {
    // Review round 2: an underscore after the "?" or "." (emphasis) is no address either.
    for (const text of ['Approve N14?', 'Done with N14.', 'N14: A', '(N14)', 'N14, then N12', 'N14?)', 'see N14...', 'N12 — merge it', '_Approve N14?_', '_Done with N14._']) {
      expect(splitLedgerRefs(text, known).some((p) => typeof p !== 'string'), text).toBe(true);
    }
  });

  it('code spans of any backtick run, ~~~ fences and indented code blocks are code', () => {
    expect(splitLedgerRefs('run ``show N14`` then N14', known)).toEqual(['run ``show N14`` then ', { seq: 14 }]);
    expect(splitLedgerRefs('``a ` N14`` and N14', known)).toEqual(['``a ` N14`` and ', { seq: 14 }]);
    expect(splitLedgerRefs('~~~\nN12: merge\n~~~\nN12', known)).toEqual(['~~~\nN12: merge\n~~~\n', { seq: 12 }]);
    expect(splitLedgerRefs('````\n```\nN12\n````\nN12', known)).toEqual(['````\n```\nN12\n````\n', { seq: 12 }]);
    expect(splitLedgerRefs('Run this:\n\n    show N14\n\tN12\n\nthen N14', known)).toEqual(['Run this:\n\n    show N14\n\tN12\n\nthen ', { seq: 14 }]);
    // An unclosed fence runs to the end; an unmatched backtick is plain text.
    expect(splitLedgerRefs('```\nN12 and N14', known)).toEqual(['```\nN12 and N14']);
    expect(splitLedgerRefs('it costs 5` and N14', known)).toEqual(['it costs 5` and ', { seq: 14 }]);
  });

  // Review round 2: a backtick fence's opening line may not contain a backtick (CommonMark), so a
  // line that starts with a code span is no fence.
  it('a line-leading code span is no fence', () => {
    expect(splitLedgerRefs('```show N14``` then N12', known)).toEqual(['```show N14``` then ', { seq: 12 }]);
    expect(splitLedgerRefs('```ts\nN12\n```\nN12', known)).toEqual(['```ts\nN12\n```\n', { seq: 12 }]);
  });

  it('an indented line inside a paragraph is no code block', () => {
    expect(splitLedgerRefs('Answers:\n    N14: A', known)).toEqual(['Answers:\n    ', { seq: 14 }, ': A']);
  });

  it('text without a known number is one string', () => {
    expect(splitLedgerRefs('nothing here', known)).toEqual(['nothing here']);
  });
});

describe('chipifyHtml — sanitized markdown', () => {
  const chips = (html: string) => {
    const div = document.createElement('div');
    div.innerHTML = chipifyHtml(html, INDEX);
    return div;
  };

  it('a known number in text becomes a chip with the question as its tooltip', () => {
    const div = chips('<p>Approve N12 now? Also N99.</p>');
    const chip = div.querySelector('[data-ledger-chip]')!;
    expect(chip.getAttribute('data-ledger-chip')).toBe('12');
    expect(chip.textContent).toBe('N12 · Merge PR #62 into main?');
    expect(chip.getAttribute('title')).toBe('Merge PR #62 into main?');
    expect(div.querySelectorAll('[data-ledger-chip]')).toHaveLength(1);
    expect(div.textContent).toBe('Approve N12 · Merge PR #62 into main? now? Also N99.');
  });

  it('never inside code, a code block or a link', () => {
    const div = chips('<p><code>N12: merge</code> <a href="#x">N14</a></p><pre><code>N14</code></pre><ul><li>N14</li></ul>');
    expect([...div.querySelectorAll('[data-ledger-chip]')].map((c) => c.getAttribute('data-ledger-chip'))).toEqual(['14']);
    expect(div.querySelector('li [data-ledger-chip]')).not.toBeNull();
  });

  it('the question text is escaped: it never becomes markup', () => {
    const div = chips('<p>N7</p>');
    const chip = div.querySelector('[data-ledger-chip]')!;
    // Inside the text and the quoted title the question stays text: no element comes of it.
    expect(div.querySelectorAll('img, b')).toHaveLength(0);
    expect(chip.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(chip.getAttribute('title')).toBe(INDEX.get(7)!.text);
    expect(chipifyHtml('<p>N7</p>', INDEX)).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('no chip in a path or URL in rendered text either', () => {
    const div = chips('<p>See docs/plans/N12-design.md and https://example.com/N12, then N14.</p>');
    expect([...div.querySelectorAll('[data-ledger-chip]')].map((c) => c.getAttribute('data-ledger-chip'))).toEqual(['14']);
  });

  it('html without a known number comes back unchanged', () => {
    expect(chipifyHtml('<p>No numbers, <em>N99</em>.</p>', INDEX)).toBe('<p>No numbers, <em>N99</em>.</p>');
  });
});
