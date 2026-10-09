/**
 * The section finder (titles and source panel spec 2026-10-09, Unit 6). Pure: the caller passes the
 * markdown text of a plan or doc, the section name the ledger item stores, and the item's own ID.
 * The answer is the section (the heading, and the markdown after it up to the next heading of the
 * same or a higher level) or the outline (every heading, with its level).
 *
 * - ATX headings only (`#` to `######`); a heading inside a fenced code block is not a heading, also
 *   when the fence opens inside a list item.
 *   Setext headings (underlined with `===` or `---`) are not found (a known limit).
 * - Names compare in a normal form: lower case, no emphasis or code marks, spaces collapsed, no end
 *   punctuation.
 * - Order of matches: an exact match; a heading that starts with the stored name (so "after v3"
 *   finds "after v3.2 (…)"); a stored name that starts with the heading; a heading that contains the
 *   stored name; a heading that contains the ID as a whole word; a heading with the same leading
 *   section number ("9."). The first heading in the file wins at each step. No match, or no stored
 *   section: the outline.
 * - A `heading` input (a click in the outline) selects that exact heading; the first one with that
 *   text wins.
 * - A section longer than 64 KB is cut at a line end (`cut: true`; the web says "The section
 *   continues in the file.").
 */

export const SECTION_MAX_BYTES = 64 * 1024;

export interface MarkdownHeading {
  level: number;
  text: string;
  /** The heading's line, 0-based, in the text with its line ends made "\n". */
  line: number;
}

export type SectionResult =
  | { kind: 'section'; heading: string; level: number; markdown: string; cut: boolean }
  | { kind: 'outline'; headings: { level: number; text: string }[] };

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const CLOSING = /(?:^|[ \t]+)#+[ \t]*$/;
// A fence may open inside a list item ("- ```md", "1. ~~~") and close indented (review round 1).
const FENCE = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*(`{3,}|~{3,})(.*)$/;

const lines = (markdown: string) => markdown.replace(/\r\n?/g, '\n').split('\n');

/** The ATX headings of the text, outside fenced code blocks, in order. */
export function markdownHeadings(markdown: string): MarkdownHeading[] {
  const out: MarkdownHeading[] = [];
  let fence: { char: string; len: number } | null = null;
  lines(markdown).forEach((line, i) => {
    const f = line.match(FENCE);
    if (fence) {
      if (f && f[1][0] === fence.char && f[1].length >= fence.len && !f[2].trim()) fence = null;
      return;
    }
    // A backtick fence's opening line holds no other backtick (CommonMark): "```x```" is a code span.
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) { fence = { char: f[1][0], len: f[1].length }; return; }
    const h = line.match(ATX);
    if (h) out.push({ level: h[1].length, text: (h[2] ?? '').replace(CLOSING, '').trim(), line: i });
  });
  return out;
}

/** The normal form names compare in: lower case, no `*`, `_`, backtick or `~`, spaces collapsed, no end punctuation. */
export function normalizeHeading(s: string): string {
  return s.toLowerCase().replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim().replace(/[.:;,!?…]+$/u, '').trim();
}

/** The leading section number of a normalized name ("9", "3.3"), or null. */
const sectionNumber = (n: string) => n.match(/^(\d+(?:\.\d+)*)\.?(?:\s|$)/)?.[1] ?? null;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The markdown after `h` up to the next heading of the same or a higher level, cut at 64 KB. */
function sectionOf(markdown: string, heads: MarkdownHeading[], h: MarkdownHeading): SectionResult {
  const all = lines(markdown);
  const next = heads.find((o) => o.line > h.line && o.level <= h.level);
  let body = all.slice(h.line + 1, next ? next.line : all.length).join('\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd();
  let cut = false;
  if (Buffer.byteLength(body, 'utf8') > SECTION_MAX_BYTES) {
    const head = Buffer.from(body, 'utf8').subarray(0, SECTION_MAX_BYTES).toString('utf8');
    const end = head.lastIndexOf('\n');
    body = end > 0 ? head.slice(0, end) : head.replace(/�+$/, '');
    cut = true;
  }
  return { kind: 'section', heading: h.text, level: h.level, markdown: body, cut };
}

export function findSection(
  markdown: string,
  opts: { section?: string | null; id?: string | null; heading?: string | null },
): SectionResult {
  const heads = markdownHeadings(markdown);
  const named = heads.filter((h) => h.text);
  const outline: SectionResult = { kind: 'outline', headings: named.map(({ level, text }) => ({ level, text })) };

  const wanted = opts.heading?.trim();
  if (wanted) {
    const h = named.find((x) => x.text === wanted);
    return h ? sectionOf(markdown, heads, h) : outline;
  }

  const name = normalizeHeading(opts.section ?? '');
  if (!name) return outline;
  const norm = named.map((h) => ({ h, n: normalizeHeading(h.text) })).filter((x) => x.n);
  const steps: ((n: string) => boolean)[] = [
    (n) => n === name,
    (n) => n.startsWith(name),
    (n) => name.startsWith(n),
    (n) => n.includes(name),
  ];
  const id = normalizeHeading(opts.id ?? '');
  if (id) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}-])${escapeRe(id)}(?![\\p{L}\\p{N}])`, 'u');
    steps.push((n) => re.test(n));
  }
  // Review round 1: last, the same section number ("9. Owner decisions" finds "9. Decisions
  // recorded (…)" after a rename); "9" never matches "9.1".
  const num = sectionNumber(name);
  if (num) steps.push((n) => sectionNumber(n) === num);
  for (const step of steps) {
    const hit = norm.find((x) => step(x.n));
    if (hit) return sectionOf(markdown, heads, hit.h);
  }
  return outline;
}
