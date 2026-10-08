// Ledger chips (pinned card spec 2026-10-08, Unit 9): the user cannot keep ledger numbers in mind,
// so on the Control Plane screen every ledger number that the project's ledger knows carries its
// question. These are the pure parts: find the numbers in plain text (outside code spans and code
// blocks) and in sanitized markdown HTML (outside <code>, <pre> and links), never in a URL or a
// path. Numbers the ledger does not know stay plain text.

import type { LedgerCard } from '../api/types';

/** One entry of the card's index: every item of the project, any status. */
export type LedgerIndexEntry = LedgerCard['index'][number];

/** What a surface needs to draw chips: the project's index, and what a click does. */
export interface LedgerChips {
  index: ReadonlyMap<number, LedgerIndexEntry>;
  onChip: (seq: number, anchor: { x: number; y: number }) => void;
}

/** A ledger number as a whole word. */
const REF = /(?<![\p{L}\p{N}_])N(\d+)(?![\p{L}\p{N}_])/gu;
/** A letter or a digit: after a "." or "?" it makes an address ("N12.md"); "_" (emphasis) does not. */
const ADDRESS_CHAR = /[\p{L}\p{N}]/u;

/**
 * True when the number at text[start, end) is part of a URL or a path, not a ledger number
 * (review round 1): it touches "/", "\\", "-", "#", "=" or "&"; a "." or "?" before it, or one
 * after it that a letter or digit follows ("N12.md", "?id=N14"); or "://" after it. A sentence
 * keeps its chip: "Approve N14?", "Done with N14.", "N14: A".
 */
function inAddress(text: string, start: number, end: number): boolean {
  const before = text[start - 1] ?? '';
  const after = text[end] ?? '';
  if (before && '/\\-#=&.?'.includes(before)) return true;
  if (after && '/\\-#=&'.includes(after)) return true;
  if ((after === '.' || after === '?') && ADDRESS_CHAR.test(text[end + 1] ?? '')) return true;
  return after === ':' && text.startsWith('//', end + 1);
}

/**
 * The [start, end) ranges of code in plain text: fenced blocks (``` or ~~~, closed by a fence of
 * the same character at least as long, else open to the end), indented blocks (lines that start
 * with 4 spaces or a tab, after a blank line or at the start), and code spans of any backtick run
 * (closed by a run of the same length; an unmatched run is plain text).
 */
function codeRanges(text: string): [number, number][] {
  const blocks: [number, number][] = [];
  let fence: { char: string; len: number; start: number } | null = null;
  let indented: [number, number] | null = null;
  let prevBlank = true;
  for (let at = 0; at <= text.length;) {
    const nl = text.indexOf('\n', at);
    const lineEnd = nl === -1 ? text.length : nl + 1;
    const line = text.slice(at, nl === -1 ? text.length : nl);
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.len && !line.slice(marker[0].length).trim()) {
        blocks.push([fence.start, lineEnd]);
        fence = null;
      }
    } else if (marker && !(marker[1][0] === '`' && line.slice(marker[0].length).includes('`'))) {
      // A backtick fence's opening line holds no other backtick (CommonMark): "```x``` …" is a span.
      if (indented) { blocks.push(indented); indented = null; }
      fence = { char: marker[1][0], len: marker[1].length, start: at };
    } else if (/^( {4}|\t)/.test(line) && line.trim() && (prevBlank || indented)) {
      indented = indented ? [indented[0], lineEnd] : [at, lineEnd];
    } else if (line.trim() && indented) {
      blocks.push(indented);
      indented = null;
    }
    prevBlank = !line.trim();
    if (nl === -1) break;
    at = lineEnd;
  }
  if (fence) blocks.push([fence.start, text.length]);
  if (indented) blocks.push(indented);
  const inBlock = (i: number) => blocks.some(([a, b]) => i >= a && i < b);

  // Code spans, outside the blocks.
  const runs = [...text.matchAll(/`+/g)].filter((m) => !inBlock(m.index!));
  const spans: [number, number][] = [];
  for (let i = 0; i < runs.length; i++) {
    const close = runs.findIndex((r, j) => j > i && r[0].length === runs[i][0].length);
    if (close === -1) continue; // an unmatched run is plain text
    spans.push([runs[i].index!, runs[close].index! + runs[close][0].length]);
    i = close;
  }
  return [...blocks, ...spans];
}

const LABEL_MAX = 70;

/** "N17 · How many clean nights…": the number and the question, cut at about 70 characters. */
export function chipLabel(seq: number, question: string): string {
  const q = question.replace(/\s+/g, ' ').trim();
  if (q.length <= LABEL_MAX) return `N${seq} · ${q}`;
  const cut = q.slice(0, LABEL_MAX);
  const space = cut.lastIndexOf(' ');
  return `N${seq} · ${(space > LABEL_MAX - 20 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Plain text as text runs and ledger refs, in order. A number in a code span or block, or in a
 * URL or a path, stays text.
 */
export function splitLedgerRefs(text: string, known: (seq: number) => boolean): (string | { seq: number })[] {
  const out: (string | { seq: number })[] = [];
  const code = /N\d/.test(text) ? codeRanges(text) : [];
  let last = 0;
  for (const m of text.matchAll(REF)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (!known(Number(m[1])) || inAddress(text, start, end) || code.some(([a, b]) => start >= a && start < b)) continue;
    if (start > last) out.push(text.slice(last, start));
    out.push({ seq: Number(m[1]) });
    last = end;
  }
  if (last < text.length || out.length === 0) out.push(text.slice(last));
  return out;
}

/** The chip element for markdown. Text and title go through the DOM, so the question is escaped. */
function chipElement(doc: Document, entry: LedgerIndexEntry): HTMLElement {
  const el = doc.createElement('span');
  el.className = 'ledger-chip';
  el.setAttribute('data-ledger-chip', String(entry.seq));
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('title', entry.text);
  el.textContent = chipLabel(entry.seq, entry.text);
  return el;
}

const SKIP = new Set(['CODE', 'PRE', 'A', 'SCRIPT', 'STYLE']);

/**
 * Sanitized markdown HTML with each known ledger number turned into a chip. Runs AFTER the
 * sanitizer, on text nodes only, so the chips (a data attribute, a role, a title) survive and the
 * question can never become markup. HTML with no known number comes back unchanged.
 */
export function chipifyHtml(html: string, index: ReadonlyMap<number, LedgerIndexEntry>): string {
  if (!index.size || !/N\d/.test(html)) return html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const doc = tpl.content.ownerDocument;
  const walker = doc.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  let changed = false;
  for (const node of nodes) {
    let skip = false;
    for (let p = node.parentElement; p; p = p.parentElement) if (SKIP.has(p.tagName)) { skip = true; break; }
    if (skip) continue;
    const text = node.data;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(REF)) {
      const entry = index.get(Number(m[1]));
      if (!entry || inAddress(text, m.index!, m.index! + m[0].length)) continue;
      if (m.index! > last) frag.append(text.slice(last, m.index));
      frag.append(chipElement(doc, entry));
      last = m.index! + m[0].length;
    }
    if (last === 0) continue;
    if (last < text.length) frag.append(text.slice(last));
    node.replaceWith(frag);
    changed = true;
  }
  return changed ? tpl.innerHTML : html;
}
