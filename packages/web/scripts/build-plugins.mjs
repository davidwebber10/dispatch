// packages/web/scripts/build-plugins.mjs
// Two build-time plugins for vite.config.ts (engineering program 2026-11-09, W2-E). They are plain
// functions over text, so scripts/build-plugins.test.mjs can test them with no build.
//
// 1. trimIconWeights: each Phosphor icon module holds six drawings (thin, light, regular, bold, fill,
//    duotone). The app draws regular, bold and fill, and duotone for two icons only, and the icons
//    are the largest part of the first load. The build keeps regular, bold and fill, keeps duotone
//    for the icons that the source draws in it (duotoneIcons), and points each dropped weight at
//    the regular drawing, so an icon asked for in one of them (a plugin could) still draws.
// 2. shellPreloadTags: the app loads one shell chunk for a phone width and another for a desktop
//    width. Without a hint the browser learns the shell's name only after it ran the entry: one more
//    round trip. index.html gets a <link rel="modulepreload"> for each chunk of each shell, with a
//    `media` attribute so a phone does not fetch the desktop's chunks (and the reverse).

const DROPPED_WEIGHTS = ['thin', 'light'];

/**
 * The icons that the source draws with weight="duotone", from the text of the source files.
 * @param {string[]} sources the text of each source file
 * @returns {Set<string> | null} the icon names; null when "duotone" is also used in a form this
 *   cannot read (a variable, a helper): the build then keeps duotone for every icon.
 */
export function duotoneIcons(sources) {
  const names = new Set();
  for (const text of sources) {
    const all = (text.match(/duotone/g) ?? []).length;
    let read = 0;
    for (const m of text.matchAll(/<([A-Z]\w*)\b[^<>]*?\bweight="duotone"/g)) { names.add(m[1].replace(/Icon$/, '')); read += 1; }
    if (read !== all) return null;
  }
  return names;
}

/**
 * @param {string} code the text of @phosphor-icons/react/dist/defs/<Icon>.es.js
 * @param {{ keepDuotone?: boolean }} [opts] keepDuotone false: "duotone" points at the regular drawing too
 * @returns {string | null} the smaller module, or null when the text does not have the known form (it is then left as it is)
 */
export function trimIconWeights(code, opts = {}) {
  const dropped = opts.keepDuotone === false ? [...DROPPED_WEIGHTS, 'duotone'] : DROPPED_WEIGHTS;
  const open = code.indexOf('new Map([');
  const close = code.lastIndexOf(']);');
  if (open < 0 || close < open) return null;
  const head = code.slice(0, code.lastIndexOf('const ', open));
  const decl = /const (\w+) = (\/\* @__PURE__ \*\/ )?new Map\(\[/.exec(code.slice(head.length, open + 9));
  if (!decl) return null;
  const body = code.slice(open + 9, close);
  // Entries are `[\n    "<weight>",\n    <expression>\n  ]`, separated by commas.
  const parts = body.split(/\n {2}\[\n {4}"(\w+)",\n/);
  if (parts[0].trim() !== '' || parts.length !== 13) return null;
  /** @type {Record<string, string>} */
  const drawings = {};
  for (let i = 1; i < parts.length; i += 2) {
    const expr = parts[i + 1].replace(/\n {2}\],?\s*$/, '');
    if (expr === parts[i + 1]) return null;
    drawings[parts[i]] = expr.trim();
  }
  const weights = ['bold', 'duotone', 'fill', 'light', 'regular', 'thin'];
  if (weights.some((w) => !drawings[w])) return null;
  const reactName = /import \* as (\w+) from "react";/.exec(head)?.[1];
  if (!reactName) return null;
  const regular = '__regular';
  const entries = weights.map((w) => `  ["${w}", ${dropped.includes(w) || w === 'regular' ? regular : drawings[w]}]`);
  return `${head}const ${regular} = ${drawings.regular};\nconst ${decl[1]} = /* @__PURE__ */ new Map([\n${entries.join(',\n')}\n]);${code.slice(close + 3)}`;
}

/** The icon name for a module that trimIconWeights handles ("Gear"), or null for any other module. */
export function iconDefsName(id) {
  return /[\\/]@phosphor-icons[\\/]react[\\/]dist[\\/]defs[\\/]([^\\/]+)\.es\.js$/.exec(id.split('?')[0])?.[1] ?? null;
}

/**
 * The files that load with `start` and with no further request: `start` and each chunk it imports
 * statically, at any depth.
 * @param {Record<string, { imports?: string[] }>} chunks keyed by file name
 * @param {string[]} start
 */
export function staticClosure(chunks, start) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file) || !chunks[file]) return;
    seen.add(file);
    for (const dep of chunks[file].imports ?? []) walk(dep);
  };
  start.forEach(walk);
  return [...seen];
}

export const PHONE_MEDIA = '(max-width: 768px)';   // the limit of hooks/useIsMobile
export const DESKTOP_MEDIA = '(min-width: 769px)';

/**
 * @param {{ entry: string[], phone: string[], desktop: string[] }} files the chunk files of the entry (already
 *   linked by Vite) and of each shell, each with its static imports
 * @returns {{ href: string, media?: string }[]} the links to add: a chunk of both shells gets no `media`
 */
export function shellPreloadLinks(files) {
  const entry = new Set(files.entry);
  const phone = files.phone.filter((f) => !entry.has(f));
  const desktop = files.desktop.filter((f) => !entry.has(f));
  const both = phone.filter((f) => desktop.includes(f));
  return [
    ...both.map((href) => ({ href })),
    ...phone.filter((f) => !both.includes(f)).map((href) => ({ href, media: PHONE_MEDIA })),
    ...desktop.filter((f) => !both.includes(f)).map((href) => ({ href, media: DESKTOP_MEDIA })),
  ];
}

/**
 * Which chunk the app's own shared code goes to. Rollup alone makes one shared chunk for each
 * combination of lazy roots that use a module: more than ten small files on the first load. The
 * daemon serves HTTP/1.1, so a browser has six connections: the seventh file of the first screen
 * waits one round trip for a free one. The build runs twice. The first pass lets Rollup place each
 * module (it knows what tree-shaking left of each import); this function reads that result and
 * gives each module a name for the second pass, from the roots (the entry, and each chunk that an
 * import() loads) whose load brings the module:
 *   - the entry, or a shell and one root more: "index", the entry chunk. The first screen of a
 *     shell needs this code, and in the entry it costs no request.
 *   - a "background" root (a small module that the entry imports with import() at each launch,
 *     for work after the first screen), and what it brings: "index" too. Each launch runs this
 *     code, so a file of its own is only a request more; and without this rule its code lands in
 *     "views", and each launch would fetch the views' code for it.
 *   - one root only: no name (it stays in that root's chunk)
 *   - several views and no shell: "views", loaded with the first view that needs it
 * Each module gets its answer by name, also the entry's: Rollup moves the unnamed static imports
 * of a named module into that module's chunk, and that would pull the entry's code into "views".
 *
 * @param {{ fileName: string, isEntry: boolean, isDynamicEntry: boolean, imports: string[], moduleIds: string[] }[]} chunks the chunks of the first pass
 * @param {{ isShell: (moduleId: string) => boolean, isBackground?: (moduleId: string) => boolean, isPinned?: (moduleId: string) => boolean }} rules
 *   isShell: the module of a shell. isBackground: the module of a background root. isPinned: a module that already has a chunk name (a vendor group); it gets none here.
 * @returns {Map<string, 'index' | 'views'>}
 */
export function sharedChunkNames(chunks, rules) {
  const { isShell, isBackground = () => false, isPinned = () => false } = rules;
  const byFile = Object.fromEntries(chunks.map((c) => [c.fileName, c]));
  const roots = chunks.filter((c) => c.isEntry || c.isDynamicEntry);
  const backgroundFiles = new Set(roots.filter((c) => !c.isEntry && c.moduleIds.some(isBackground)).map((c) => c.fileName));
  /** @type {Map<string, Set<string>>} chunk file -> the roots whose load brings it */
  const rootsOfChunk = new Map(chunks.map((c) => [c.fileName, new Set()]));
  for (const root of roots) for (const file of staticClosure(byFile, [root.fileName])) rootsOfChunk.get(file)?.add(root.fileName);
  const entryFiles = new Set(roots.filter((c) => c.isEntry).map((c) => c.fileName));
  const shellFiles = new Set(roots.filter((c) => c.moduleIds.some(isShell)).map((c) => c.fileName));
  const names = new Map();
  for (const c of chunks) {
    const mine = [...rootsOfChunk.get(c.fileName)];
    // A background root does not make its code "shared": the other roots decide.
    const others = mine.filter((r) => !backgroundFiles.has(r));
    const withBackground = mine.length > others.length; // the launch runs this code
    const withShell = others.some((r) => shellFiles.has(r));
    let name;
    if (mine.some((r) => entryFiles.has(r))) name = 'index';
    else if (withShell && others.length > 1) name = 'index';
    else if (withBackground) name = 'index';
    else if (others.length > 1) name = 'views';
    if (!name) continue;
    for (const id of c.moduleIds) if (!isPinned(id)) names.set(id, name);
  }
  return names;
}
