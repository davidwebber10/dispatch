// Ledger chips (pinned card spec 2026-10-08, Unit 9): the user cannot keep ledger numbers in mind,
// so on the Control Plane screen every ledger number that the project's ledger knows carries its
// question. These are the pure parts: find the numbers in plain text (outside code spans and code
// blocks) and in sanitized markdown HTML (outside <code>, <pre> and links). Numbers the ledger does
// not know stay plain text.

import type { LedgerCard } from '../api/types';

/** One entry of the card's index: every item of the project, any status. */
export type LedgerIndexEntry = LedgerCard['index'][number];

/** What a surface needs to draw chips: the project's index, and what a click does. */
export interface LedgerChips {
  index: ReadonlyMap<number, LedgerIndexEntry>;
  onChip: (seq: number, anchor: { x: number; y: number }) => void;
}

/** A code block or span (left as is), or a ledger number as a whole word. */
const TOKENS = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)|(?<![\p{L}\p{N}_])N(\d+)(?![\p{L}\p{N}_])/gu;
/** A ledger number as a whole word, for text that holds no code (an HTML text node). */
const REF = /(?<![\p{L}\p{N}_])N(\d+)(?![\p{L}\p{N}_])/gu;

const LABEL_MAX = 70;

/** "N17 · How many clean nights…": the number and the question, cut at about 70 characters. */
export function chipLabel(seq: number, question: string): string {
  const q = question.replace(/\s+/g, ' ').trim();
  if (q.length <= LABEL_MAX) return `N${seq} · ${q}`;
  const cut = q.slice(0, LABEL_MAX);
  const space = cut.lastIndexOf(' ');
  return `N${seq} · ${(space > LABEL_MAX - 20 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Plain text as text runs and ledger refs, in order. A number in a code span or block stays text. */
export function splitLedgerRefs(text: string, known: (seq: number) => boolean): (string | { seq: number })[] {
  const out: (string | { seq: number })[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKENS)) {
    if (m[1] !== undefined || !known(Number(m[2]))) continue;
    if (m.index! > last) out.push(text.slice(last, m.index));
    out.push({ seq: Number(m[2]) });
    last = m.index! + m[0].length;
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
      if (!entry) continue;
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
