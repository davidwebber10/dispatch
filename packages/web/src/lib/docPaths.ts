// File chips in chat (chat thread visibility spec 12.2, section 15; widened to every file type): a path
// to a file in a Dispatch reply, a report card or a Started card's task becomes a chip. These are the
// pure parts: find the paths in plain text, name the file, and pick the project that owns it.

export interface DocSpan { start: number; end: number; path: string; branch: string | null }

// A path: absolute or relative, made of path characters, ending in a file extension (a letter, then
// letters or digits; "7z" too). Not part of a URL, not a stem of a longer name ("a.md/x" gives no "a.md"), and not
// after an "@" or "~" of the same word (so a run of "@" cannot make the regex try every
// start). Trailing punctuation is not part of the path. The filters below remove what the regex cannot:
// domains, email addresses, and bare words such as "e.g." or "Node.js".
const PATH = /(?<![\w:/.@~-])((?:\/|\.{0,2}\/)?[\w.@-]+(?:\/[\w.@-]+)*\.(?:[a-z][a-z0-9]{0,9}|7z))(?![\w/-]|\.\w)/gi;
/** Top-level domains: "example.com", "socket.io" or "www.x.org/a.html" is a site, not a file. Not .sh, .py, .rs, .ts, .md, .cc. */
const TLD = new Set(['com', 'org', 'net', 'io', 'dev', 'app', 'ai', 'co', 'edu', 'gov', 'info', 'biz', 'xyz', 'us', 'uk', 'de', 'fr', 'ca', 'me', 'tv']);
/** A name with no folder in it is a file only with one of these extensions: "extract.py" is, "e.g." and "v3.5" are not. */
const BARE_EXT = new Set((
  'md markdown txt rst json jsonl ndjson yml yaml toml ini cfg conf lock xml html htm css scss less svg ' +
  'js mjs cjs jsx ts tsx mts cts py pyi ipynb rb go rs java kt kts swift c h cc cpp hpp cs php pl lua r sql sh bash zsh ps1 bat ' +
  'csv tsv xlsx xls xlsm parquet avro orc db sqlite sqlite3 ' +
  'png jpg jpeg gif webp avif bmp pdf zip tar gz tgz bz2 xz 7z docx doc pptx ppt rtf pkl pickle npy npz ' +
  'tf hcl proto graphql gql vue svelte patch diff dockerfile makefile'
).split(' '));
/** Well-known project names that end like a file: "Node.js" is not a script. */
const NOT_FILES = new Set(['node.js', 'next.js', 'vue.js', 'react.js', 'nuxt.js', 'express.js', 'three.js', 'd3.js', 'chart.js', 'p5.js', 'ember.js', 'backbone.js', 'angular.js', 'nest.js', 'deno.js']);

/** True when a matched path is a file path, not a domain, a version, an abbreviation or a product name. */
function isFilePath(path: string, next: string): boolean {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (TLD.has(ext)) return false;
  const slash = path.indexOf('/');
  // A bare name followed by "(" is a call ("res.json(data)"), not a file.
  if (slash < 0) return BARE_EXT.has(ext) && !NOT_FILES.has(path.toLowerCase()) && next !== '(';
  // "www.example.com/about.html": a first folder that is a domain makes the whole thing a web address.
  const first = path.slice(0, slash);
  if (first.includes('.') && !/^\.{0,2}$/.test(first) && TLD.has(first.slice(first.lastIndexOf('.') + 1).toLowerCase())) return false;
  return true;
}

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
    if (!isFilePath(path, text[start + path.length] ?? '')) continue;
    const end = start + path.length;
    BRANCH.lastIndex = end;
    const b = BRANCH.exec(text);
    out.push({ start, end, path, branch: b ? b[1] : null });
  }
  return out;
}

/** The file name of a path. */
export const docName = (p: string) => p.split('/').pop() || p;

/** What opening a file does: a doc opens the doc viewer, an image or any text opens a file tab, other binary (no viewer) downloads. */
export type FileKind = 'doc' | 'image' | 'text' | 'binary';
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp']);
const BINARY_EXT = new Set((
  'xlsx xls xlsm xlsb parquet avro orc pdf zip tar gz tgz bz2 xz 7z rar docx doc pptx ppt pkl pickle npy npz db sqlite sqlite3 ' +
  'bin exe dll so dylib class jar pyc o a dmg iso mp3 mp4 mov avi mkv wav flac woff woff2 ttf otf eot ico psd'
).split(' '));
export function fileKind(path: string): FileKind {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') return 'doc';
  if (IMAGE_EXT.has(ext)) return 'image';
  return BINARY_EXT.has(ext) ? 'binary' : 'text';
}

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

/**
 * The project and the project-relative path of a file path in a message. An absolute path is as in
 * projectForPath. A relative path that starts with the folder name of another known project
 * ("sandbox/notes/board.md") belongs to that project, with that name removed; else the message project.
 * Two projects with the same folder name, or the message project's own name, leave the path as it is.
 */
export function resolveProjectPath(p: string, messageProject: string | null, projects: { id: string; folder: string }[]): { project: string; path: string } | null {
  if (p.startsWith('/')) {
    const project = projectForPath(p, messageProject, projects);
    return project ? { project, path: p } : null;
  }
  const slash = p.indexOf('/');
  if (slash > 0) {
    const first = p.slice(0, slash);
    const owners = projects.filter((x) => x.id !== messageProject && x.folder && x.folder.replace(/\/+$/, '').split('/').pop() === first);
    if (owners.length === 1 && p.length > slash + 1) return { project: owners[0].id, path: p.slice(slash + 1) };
  }
  return messageProject ? { project: messageProject, path: p } : null;
}
