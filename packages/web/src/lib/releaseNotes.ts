/**
 * Release notes are written as `docs/releases/vX.Y.Z.md`, and every one of them opens
 * with an H1 like `# Dispatch v2.9.0 — coordinator session controls`. The notes panel
 * already prints the version in its own row, so that H1 would repeat it. Split the
 * headline off instead: the panel shows it as a subtitle, and the body renders without
 * a duplicate title.
 */
export interface SplitNote {
  /** The H1 text with any `Dispatch vX.Y.Z —` prefix removed, or null if there was no H1. */
  headline: string | null;
  /** The note with that H1 removed. */
  body: string;
}

const H1 = /^#[ \t]+(.+?)[ \t]*$/;
const VERSION_PREFIX = /^dispatch\s+v?\d+\.\d+\.\d+\s*[—–-]?\s*/i;

export function splitNoteHeadline(markdown: string): SplitNote {
  const lines = (markdown ?? '').split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;

  const match = lines[i] !== undefined ? H1.exec(lines[i]) : null;
  if (!match) return { headline: null, body: (markdown ?? '').trim() };

  const headline = match[1].replace(VERSION_PREFIX, '').trim();
  return {
    headline: headline === '' ? null : headline,
    body: lines.slice(i + 1).join('\n').trim(),
  };
}
