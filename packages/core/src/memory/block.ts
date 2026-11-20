/**
 * What a thread gets at its start (spec 2026-11-17-memory-design.md, section 4.3, design review
 * 2026-11-19): TOOLS FIRST, so the text is small. A short pointer that says what memory is for and
 * names memory_search, and one line for each page the PERSON pinned (none by default). No index, no
 * notes, no rule about when to write. Pure: the service hands the pinned pages in.
 */

export const MEMORY_POINTER = [
  '## Memory',
  '',
  'You have a memory that lasts between threads: what the person and earlier threads learned that the',
  'code and the tools do not show, from Dispatch and from the harnesses\' own memories. memory_search finds',
  'it (with no query it lists what is there); memory_read opens an entry; remember saves a note.',
].join('\n');

export const MORE_LINE = '(More pinned pages: use memory_search.)';
const LINE_CHARS = 160;

export interface PinnedPage { slug: string; description: string; scope: 'you' | 'project' }

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

/** The pointer, then the pinned pages; never longer than `cap` (pinned lines go from the end first). */
export function buildBlock(input: { pinned: PinnedPage[]; cap: number }): string {
  const lines = input.pinned.map((p) => `- ${oneLine(p.slug, 64)}${p.description ? `: ${oneLine(p.description, LINE_CHARS)}` : ''}${p.scope === 'you' ? ' (you)' : ''}`);
  const render = (shown: string[], cut: boolean) =>
    [MEMORY_POINTER, ...(shown.length ? [`Pinned by the person:\n${shown.join('\n')}`] : []), ...(cut ? [MORE_LINE] : [])].join('\n\n');
  let shown = lines;
  let text = render(shown, false);
  while (text.length > input.cap && shown.length) {
    shown = shown.slice(0, -1);
    text = render(shown, true);
  }
  return text.length > input.cap ? text.slice(0, input.cap) : text;
}
