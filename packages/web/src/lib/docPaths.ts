// Doc links in chat (chat thread visibility spec 12.2, section 15): a path to a .md, .markdown or
// .txt file in a Dispatch reply, a report card or a Started card's task becomes a doc chip. These are
// the pure parts: find the paths in plain text, name the file, and pick the project that owns it.

export interface DocSpan { start: number; end: number; path: string; branch: string | null }

// A path: absolute or relative, made of path characters, ending in a doc extension. Not part of a
// URL or a longer name ("a.md.bak", "a.mdx"), and not after an "@" or "~" of the same word (so a run
// of "@" cannot make the regex try every start). Trailing punctuation is not part of the path.
const PATH = /(?<![\w:/.@~-])((?:\/|\.{0,2}\/)?[\w.@-]+(?:\/[\w.@-]+)*\.(?:md|markdown|txt))(?![\w/-]|\.\w)/gi;
/** The "(branch NAME)" right after a path (sticky: it reads at `lastIndex` only). */
const BRANCH = /\s*\(branch ([\w./@-]+)\)/y;
/** The URL check looks back at most this far for the start of the word. */
const WORD_MAX = 2048;

/** True when the word before `start` (back to the last whitespace, at most WORD_MAX characters) holds a URL scheme. */
function inUrl(text: string, start: number): boolean {
  let from = start;
  const stop = Math.max(0, start - WORD_MAX);
  while (from > stop && !/\s/.test(text[from - 1])) from--;
  return text.slice(from, start).includes('://');
}

export function findDocPaths(text: string): DocSpan[] {
  const out: DocSpan[] = [];
  for (const m of text.matchAll(PATH)) {
    const start = m.index ?? 0;
    if (inUrl(text, start)) continue; // inside a URL
    const path = m[1];
    const end = start + path.length;
    BRANCH.lastIndex = end;
    const b = BRANCH.exec(text);
    out.push({ start, end, path, branch: b ? b[1] : null });
  }
  return out;
}

/** The file name of a path. */
export const docName = (p: string) => p.split('/').pop() || p;

/**
 * The project a doc path belongs to: an absolute path belongs to the registered project whose folder
 * holds it (the longest match); a relative path uses the message's project; else none (no link).
 */
export function projectForPath(p: string, messageProject: string | null, projects: { id: string; folder: string }[]): string | null {
  if (!p.startsWith('/')) return messageProject;
  const hit = projects
    .filter((x) => x.folder && (p === x.folder || p.startsWith(x.folder.replace(/\/$/, '') + '/')))
    .sort((a, b) => b.folder.length - a.folder.length)[0];
  return hit?.id ?? null;
}
