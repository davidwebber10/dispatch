/**
 * The memory block that every thread gets at its start (spec 2026-11-17-memory-design.md, section 4.3).
 * Pure: the service reads the store and hands the parts in.
 *
 * The text says what memory is for and gives no rule about when to write (section 3, principle 4).
 * It is at most `cap` characters: when it is longer, lines are cut from the last section first, and
 * one line says to search for more. Every line that comes from a page or a note is sanitized.
 */

export const MEMORY_PREAMBLE = [
  '## Memory',
  '',
  'You have a memory that lasts between threads. It holds what the person and earlier',
  'threads learned that the code and the tools do not show. Search it and read it when it',
  'can help. Save a note when something is worth knowing next time.',
  'Memory can be out of date. Check a fact that matters before you rely on it.',
].join('\n');

export const MORE_LINE = '(More is in memory: use memory_search.)';
/** At most this many lines from each scope's "Where to start". */
export const START_LINES = 40;
/** At most this many new notes. */
export const NOTE_LINES = 10;
const NOTE_LINE_CHARS = 200;

export interface BlockPage { slug: string; description: string; pinned: boolean }
export interface BlockScope {
  /** The text of the scope's `index` page, when it has one: its "Where to start" part is used. */
  indexBody: string | null;
  /** The other active pages, in the order to show (pinned first). Used when there is no index page. */
  pages: BlockPage[];
}
export interface BlockInput {
  you: BlockScope | null;
  project: BlockScope | null;
  /** New notes of the readable scopes, newest first. */
  notes: { text: string; scope: 'you' | 'project' }[];
  cap: number;
}

/**
 * Text from memory must not pass for the harness's own markup or a message from someone else:
 * control characters go, a tag-like `<name ...>` becomes `‹name ...›`, a line that starts like a
 * turn marker or a Dispatch sender line is quoted, and a heading becomes plain text.
 */
export function neutralize(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁠-⁤﻿]/g, '')
    .replace(/<(\/?[A-Za-z!?][^<>]*)>/g, '‹$1›')
    .replace(/<\|/g, '‹|').replace(/\|>/g, '|›')
    .split('\n')
    .map((line) => line
      .replace(/^(\s*)#+\s*/, '$1')
      .replace(/^(\s*)(human|assistant|user|system)\s*:/i, '$1"$2":')
      .replace(/^(\s*)\[from /i, '$1(from '))
    .join('\n');
}

const oneLine = (s: string, max: number): string => {
  const t = neutralize(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** The "Where to start" lines of a scope: from its index page, else one line per page. */
export function startLines(scope: BlockScope): string[] {
  if (scope.indexBody != null && scope.indexBody.trim()) {
    const lines = scope.indexBody.split('\n');
    const at = lines.findIndex((l) => /^#+\s*where to start\b/i.test(l.trim()));
    let part: string[];
    if (at >= 0) {
      const end = lines.findIndex((l, i) => i > at && /^#+\s/.test(l.trim()));
      part = lines.slice(at + 1, end < 0 ? undefined : end);
    } else {
      part = lines.filter((l) => !/^---\s*$/.test(l));
    }
    return part.map((l) => neutralize(l).trimEnd()).filter((l) => l.trim()).slice(0, START_LINES);
  }
  return scope.pages.slice(0, START_LINES).map((p) => `- ${p.slug}${p.description ? `: ${oneLine(p.description, 160)}` : ''}`);
}

/** The block, or '' when there is nothing to say (memory off is decided by the caller). */
export function buildBlock(input: BlockInput): string {
  const sections: { title: string; lines: string[] }[] = [];
  if (input.you) sections.push({ title: '### You', lines: startLines(input.you) });
  if (input.project) sections.push({ title: '### This project', lines: startLines(input.project) });
  const notes = input.notes.slice(0, NOTE_LINES).map((n) => `- ${oneLine(n.text, NOTE_LINE_CHARS)}${n.scope === 'you' ? ' (you)' : ''}`);
  sections.push({ title: '### New notes (not organized yet)', lines: notes });

  const render = (cut: boolean): string => {
    const parts = [MEMORY_PREAMBLE];
    for (const s of sections) if (s.lines.length) parts.push(`${s.title}\n${s.lines.join('\n')}`);
    if (cut) parts.push(MORE_LINE);
    return parts.join('\n\n');
  };
  let text = render(false);
  let cut = false;
  while (text.length > input.cap) {
    const last = [...sections].reverse().find((s) => s.lines.length);
    if (!last) break;
    last.lines.pop();
    cut = true;
    text = render(true);
  }
  // A cap smaller than the preamble itself: the preamble still goes, cut to the cap.
  return text.length > input.cap ? text.slice(0, input.cap) : text;
}
