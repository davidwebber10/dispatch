// File chips in chat (chat thread visibility spec 12.2, section 15; widened to every file type): a path
// to a file in a Dispatch reply, a report card or a Started card's task becomes a chip. These are the
// pure parts: find the paths in plain text, name the file, and pick the project that owns it.

export interface DocSpan { start: number; end: number; path: string; branch: string | null }

// A path: absolute or relative, made of path characters, ending in a file extension (a letter, then up to 31
// letters or digits; "7z" too; a longer one is left alone, never cut). Not part of a URL, not a stem of a longer name ("a.md/x" gives no "a.md"), and not
// after an "@" or "~" of the same word (so a run of "@" cannot make the regex try every
// start), and not after a backslash (a Windows path is no chip at all, never a chip for its last part). Trailing punctuation is not part of the path. The filters below remove what the regex cannot:
// domains, email addresses, and bare words such as "e.g." or "Node.js".
const PATH = /(?<![\w:/.@~\\-])((?:\/|\.{0,2}\/)?[\w.@-]+(?:\/[\w.@-]+)*\.(?:[a-z][a-z0-9]{0,31}|7z))(?![\w/-]|\.\w)/gi;
/** Top-level domains: "example.com", "socket.io" or "www.x.org/a.html" is a site, not a file. Not .sh, .py, .rs, .ts, .md, .cc. */
const TLD = new Set(['com', 'org', 'net', 'io', 'dev', 'app', 'ai', 'co', 'edu', 'gov', 'info', 'biz', 'xyz', 'us', 'uk', 'de', 'fr', 'ca', 'me', 'tv']);
/** A name with no folder in it is a file only with one of these extensions: "extract.py" is, "e.g." and "v3.5" are not. */
const BARE_EXT = new Set((
  'md markdown txt rst json jsonl ndjson yml yaml toml ini cfg conf lock xml html htm css scss less svg ' +
  'js mjs cjs jsx ts tsx mts cts py pyi ipynb rb go rs java kt kts swift c h cc cpp hpp cs php pl lua r sql sh bash zsh ps1 bat ' +
  'csv tsv xlsx xls xlsm parquet avro orc db sqlite sqlite3 ' +
  'png jpg jpeg gif webp avif bmp pdf zip tar gz tgz bz2 xz 7z docx doc pptx ppt rtf pkl pickle npy npz ' +
  'tf hcl proto graphql gql vue svelte patch diff'
).split(' '));
/** A bare name is a file with a text extension above, a picture type, or a binary type of 3 or more letters ("x.a", "x.o" and "x.so" are not). */
const isBareExt = (ext: string) => BARE_EXT.has(ext) || IMAGE_EXT.has(ext) || (ext.length >= 3 && BINARY_EXT.has(ext));
/** True for a file type the app shows as text: a text or code type from the list above (not a picture or a binary type). */
export function isKnownTextExt(path: string): boolean {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return BARE_EXT.has(ext) && !IMAGE_EXT.has(ext) && !BINARY_EXT.has(ext);
}
/** Well-known project names that end like a file: "Node.js" is not a script. */
const NOT_FILES = new Set(['node.js', 'next.js', 'vue.js', 'react.js', 'nuxt.js', 'express.js', 'three.js', 'd3.js', 'chart.js', 'p5.js', 'ember.js', 'backbone.js', 'angular.js', 'nest.js', 'deno.js']);

/** Domain endings of web addresses: the common ones, all country codes, and the usual newer ones. A dotted first folder that ends in one is a host name. */
const HOST_TLD = new Set((
  'com org net io dev app ai co edu gov info biz xyz mil int name pro cloud tech online site store shop blog page link live website space bar club ' +
  'agency solutions systems network digital studio design media news email world today life work zone team group ' +
  'ac ad ae af ag al am ao ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bw by bz ca cd cf cg ch ci ck cl cm cn cr cu cv cw cx cy cz ' +
  'de dj dk dm do dz ec ee eg er es et eu fi fj fk fm fo fr ga gd ge gf gg gh gi gl gm gn gp gq gr gt gu gw gy hk hn hr ht hu id ie il im in iq ir is it ' +
  'je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz ' +
  'na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sk sl sm sn so sr ss st sv sx sy sz ' +
  'tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw'
).split(' '));

/** True when a first folder looks like a host name ("www.example.org", "example.fr"): dotted, and starting with www or ending in a domain ending that is not a file type. */
function looksLikeHost(first: string): boolean {
  if (!first.includes('.') || /^\.{0,2}$/.test(first)) return false;
  const labels = first.toLowerCase().split('.');
  const last = labels[labels.length - 1];
  if (labels[0] === 'www') return true;
  return HOST_TLD.has(last) && !isBareExt(last);
}

/** True when a matched path is a file path, not an email address, a domain, a version, an abbreviation or a product name. */
function isFilePath(path: string, next: string): boolean {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (TLD.has(ext)) return false;
  const slash = path.indexOf('/');
  const first = slash < 0 ? path : path.slice(0, slash);
  // "jo@example.sh": an "@" inside the first word is an email address. A leading "@" is a package scope ("@types/node").
  if (first.indexOf('@') > 0) return false;
  // A bare name followed by "(" is a call ("res.json(data)"), not a file.
  if (slash < 0) return isBareExt(ext) && !NOT_FILES.has(path.toLowerCase()) && next !== '(';
  // "www.example.com/about.html": a first folder that is a host name makes the whole thing a web address.
  return !looksLikeHost(first);
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
  'xlsx xls xlsm xlsb parquet avro orc feather arrow h5 hdf5 pdf zip tar gz tgz bz2 xz zst lz4 rar 7z cab deb rpm apk ipa msi dmg iso ' +
  'docx doc pptx ppt odt ods odp epub pages numbers pkl pickle npy npz onnx safetensors gguf tflite db sqlite sqlite3 mdb accdb ' +
  'bin exe dll so dylib class jar pyc o a wasm mp3 mp4 mov avi mkv wav flac ogg m4a aac webm wmv flv ' +
  'woff woff2 ttf otf eot ico icns psd heic heif tif tiff'
).split(' '));
export function fileKind(path: string): FileKind {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') return 'doc';
  if (IMAGE_EXT.has(ext)) return 'image';
  return BINARY_EXT.has(ext) ? 'binary' : 'text';
}

const strip = (folder: string) => folder.replace(/\/+$/, '');
type Projects = { id: string; folder: string }[];

/** A path's parts with "." and ".." stepped out. Null when a ".." leads above the start. */
function stepOut(parts: string[]): string[] | null {
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!out.length) return null; out.pop(); continue; }
    out.push(seg);
  }
  return out;
}

/**
 * The project folder that holds a normal absolute path: the longest one. Two projects with the very
 * same folder: the message project if it is one of them, else none (no guess).
 */
function ownerOf(abs: string, messageProject: string | null, projects: Projects): { id: string; folder: string } | null {
  const hits = projects.filter((x) => x.folder && (abs === strip(x.folder) || abs.startsWith(strip(x.folder) + '/')));
  if (!hits.length) return null;
  const longest = Math.max(...hits.map((h) => strip(h.folder).length));
  const top = hits.filter((h) => strip(h.folder).length === longest);
  return top.length === 1 ? top[0] : top.find((h) => h.id === messageProject) ?? null;
}

/**
 * The project a doc path belongs to: an absolute path belongs to the registered project whose folder
 * holds it (the longest match, ".." stepped out first, so no path leaves the folder); a relative path
 * uses the message's project; else none (no link).
 */
export function projectForPath(p: string, messageProject: string | null, projects: Projects): string | null {
  if (!p.startsWith('/')) return messageProject;
  const parts = stepOut(p.split('/'));
  return parts ? ownerOf('/' + parts.join('/'), messageProject, projects)?.id ?? null : null;
}

/**
 * The project and the paths of a file path in a message. `path` is the path with "." and ".." stepped
 * out (absolute stays absolute; for a doc). `rel` is the path inside the project (for a file tab or a
 * download: a relative path is the one the server also checks for symlinks). A path that leaves its
 * project through ".." has no project. An absolute path goes to the longest project folder that holds it.
 * A relative path that starts with the folder name of another known project ("sandbox/notes/board.md")
 * belongs to that project, with that name removed; two such projects: no project, no guess. The message
 * project's own folder name is not removed, and when it is also another project's folder name there is no project. Else the message project.
 */
export function resolveProjectPath(p: string, messageProject: string | null, projects: Projects): { project: string; path: string; rel: string } | null {
  const parts = stepOut(p.split('/'));
  if (!parts || !parts.length) return null;
  if (p.startsWith('/')) {
    const abs = '/' + parts.join('/');
    const owner = ownerOf(abs, messageProject, projects);
    if (!owner) return null;
    const rel = abs.slice(strip(owner.folder).length + 1);
    return rel ? { project: owner.id, path: abs, rel } : null;
  }
  if (parts.length > 1) {
    const named = (x: { folder: string }) => !!x.folder && strip(x.folder).split('/').pop() === parts[0];
    const owners = projects.filter((x) => x.id !== messageProject && named(x));
    // The message project has the same folder name: the path could mean its own subfolder or the other project.
    if (owners.length > 1 || (owners.length === 1 && projects.some((x) => x.id === messageProject && named(x)))) return null;
    if (owners.length === 1) { const rest = parts.slice(1).join('/'); return { project: owners[0].id, path: rest, rel: rest }; }
  }
  const rel = parts.join('/');
  return messageProject ? { project: messageProject, path: rel, rel } : null;
}
