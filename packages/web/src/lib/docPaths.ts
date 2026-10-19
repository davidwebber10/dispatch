// Doc links in chat (chat thread visibility spec 12.2, section 15): a path to a .md, .markdown or
// .txt file in a Dispatch reply, a report card or a Started card's task becomes a doc chip. These are
// the pure parts: find the paths in plain text, name the file, and pick the project that owns it.

export interface DocSpan { start: number; end: number; path: string; branch: string | null }

// A path: absolute or relative, made of path characters, ending in a doc extension. Not part of a
// URL or a longer name ("a.md.bak", "a.mdx"). Trailing punctuation is not part of the path.
const PATH = /(?<![\w:/.-])((?:\/|\.{0,2}\/)?[\w.@-]+(?:\/[\w.@-]+)*\.(?:md|markdown|txt))(?![\w/-]|\.\w)/gi;
/** The "(branch NAME)" right after a path. */
const BRANCH = /^\s*\(branch ([\w./@-]+)\)/;
/** A URL scheme anywhere in the word before the path: the path is part of that URL. */
const URL_WORD = /[a-z][a-z0-9+.-]*:\/\//i;

export function findDocPaths(text: string): DocSpan[] {
  const out: DocSpan[] = [];
  for (const m of text.matchAll(PATH)) {
    const start = m.index ?? 0;
    const word = /\S*$/.exec(text.slice(0, start))?.[0] ?? '';
    if (URL_WORD.test(word)) continue; // inside a URL
    const path = m[1];
    const end = start + path.length;
    const b = BRANCH.exec(text.slice(end));
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
