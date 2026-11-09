// packages/web/scripts/check-bundle.mjs
// The bundle budget (engineering program 2026-11-09, W2-E). Run it after a build:
//
//   node scripts/check-bundle.mjs [dist] [--json]
//
// It reads dist/.vite/manifest.json and dist/index.html and fails (exit code 1) when:
//   - the entry chunk is over its gzip budget;
//   - the first-paint path of the phone or of the desktop is over its brotli budget or its file
//     budget. The first-paint path is what the browser must have before the first screen: the
//     entry, the chunks it imports statically, the shell for that width with its static imports,
//     and the CSS of all of them (the desktop path also holds the thread view: the desktop shows a
//     thread at once);
//   - the phone's path holds the desktop shell or the reverse, or a path holds a chunk that must
//     load on demand (Settings, the Control Plane, Analytics, the terminal, the editors, the game);
//   - a chunk of a first-paint path is not announced in index.html (the entry script or a
//     modulepreload link that applies to that width): the browser would then find it one round
//     trip late.
// The brotli sizes are the daemon's (web-assets.ts serves .br at quality 11); the round trips are
// an estimate for a new connection (see `roundTrips`).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const BUDGETS = {
  /** The plan's budget for the entry chunk. */
  entryGzip: 260_000,
  /** JS and CSS of a first-paint path, brotli. Set a little over the sizes at W2-E; lower them when the path gets smaller. */
  firstPaintBrotli: { phone: 285_000, desktop: 340_000 },
  /** JS files of a first-paint path: each one is a request. */
  firstPaintFiles: { phone: 6, desktop: 8 },
};

export const SHELLS = {
  phone: { shell: 'src/components/mobile/MobileApp.tsx', also: [], media: 390 },
  // "views" holds the thread view (tabs/TabHost.tsx) and what the lazy views share (vite.config.ts, sharedChunks).
  desktop: { shell: 'src/components/layout/DesktopShell.tsx', also: ['views'], media: 1280 },
};

/** Modules that load on demand: none of them may be in a first-paint path. `desktop` lists the ones its path may hold. */
export const ON_DEMAND = [
  'src/components/settings/allSections.ts',
  'src/components/settings/SettingsView.tsx',
  'src/components/overseer/OverseerView.tsx',
  'src/components/endless/ChatMode.tsx',
  'src/components/analytics/AnalyticsView.tsx',
  'src/components/tabs/TerminalTab.tsx',
  'src/components/tabs/NotesTab.tsx',
  'src/components/tabs/FileEditorTab.tsx',
  'src/components/setup/SetupWizard.tsx',
  'src/components/update/blaster/Blaster.tsx',
  'src/lib/highlightLanguages.ts',
];
/** Chunk names that load on demand (vendor groups with no manifest source). */
export const ON_DEMAND_NAMES = ['terminal', 'views'];

const size = (buf) => ({
  raw: buf.length,
  gzip: zlib.gzipSync(buf, { level: 9 }).length,
  brotli: zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }).length,
});
const add = (a, b) => ({ raw: a.raw + b.raw, gzip: a.gzip + b.gzip, brotli: a.brotli + b.brotli });

/**
 * Round trips to receive `bytes` on one new TCP connection: the sender starts with 10 segments
 * (about 14,600 bytes) and doubles each round trip (slow start). It is an estimate: it leaves out
 * the connection setup and the request, and a browser spreads the files over several connections.
 */
export function roundTrips(bytes) {
  let window = 14_600; let sent = 0; let trips = 0;
  while (sent < bytes) { sent += window; window *= 2; trips += 1; }
  return trips;
}

/** `media` of a preload link ("(max-width: 768px)") against a page width. No media: it applies. */
function mediaApplies(media, width) {
  if (!media) return true;
  const max = /max-width:\s*(\d+)px/.exec(media);
  const min = /min-width:\s*(\d+)px/.exec(media);
  return (!max || width <= Number(max[1])) && (!min || width >= Number(min[1]));
}

/** The script and preload links of index.html: [{ href, media }] with hrefs as manifest file names. */
export function announcedFiles(html) {
  const out = [];
  const norm = (href) => href.replace(/^\.?\//, '');
  for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)) out.push({ href: norm(m[1]) });
  for (const m of html.matchAll(/<link\b[^>]*>/g)) {
    const tag = m[0];
    if (!/\brel="(modulepreload|preload|stylesheet)"/.test(tag)) continue;
    const href = /\bhref="([^"]+)"/.exec(tag)?.[1];
    if (href) out.push({ href: norm(href), media: /\bmedia="([^"]+)"/.exec(tag)?.[1] });
  }
  return out;
}

/**
 * @param {string} distDir
 * @param {{ budgets?: typeof BUDGETS }} [opts]
 * @returns {{ ok: boolean, errors: string[], report: object }}
 */
export function checkBundle(distDir, opts = {}) {
  const budgets = { ...BUDGETS, ...opts.budgets };
  const errors = [];
  let manifest; let html;
  try { manifest = JSON.parse(fs.readFileSync(path.join(distDir, '.vite', 'manifest.json'), 'utf8')); }
  catch { return { ok: false, errors: [`no readable ${path.join(distDir, '.vite', 'manifest.json')}: build first`], report: {} }; }
  try { html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8'); }
  catch { return { ok: false, errors: [`no readable ${path.join(distDir, 'index.html')}`], report: {} }; }

  const sizes = new Map();
  const sizeOf = (file) => {
    if (!sizes.has(file)) {
      try { sizes.set(file, size(fs.readFileSync(path.join(distDir, file)))); }
      catch { errors.push(`the manifest names ${file}, which is not in dist`); sizes.set(file, { raw: 0, gzip: 0, brotli: 0 }); }
    }
    return sizes.get(file);
  };

  const entryKey = Object.keys(manifest).find((k) => manifest[k].isEntry);
  if (!entryKey) return { ok: false, errors: ['the manifest has no entry chunk'], report: {} };
  const entry = manifest[entryKey];

  /** Manifest keys that load with `keys` and with no further request (static imports, any depth). */
  const closure = (keys) => {
    const seen = new Set();
    const walk = (k) => { if (seen.has(k) || !manifest[k]) return; seen.add(k); for (const d of manifest[k].imports ?? []) walk(d); };
    keys.forEach(walk);
    return [...seen];
  };
  /** The manifest key for a source module with a chunk of its own, or for a named chunk ("views"). */
  const keyOf = (ref) => (manifest[ref] ? ref : Object.keys(manifest).find((k) => manifest[k].name === ref && !manifest[k].src) ?? null);

  const entrySize = sizeOf(entry.file);
  if (entrySize.gzip > budgets.entryGzip) errors.push(`the entry chunk ${entry.file} is ${entrySize.gzip} bytes gzip: over the budget of ${budgets.entryGzip}`);

  const announced = announcedFiles(html);
  const stylesheets = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)].map((m) => /\bhref="([^"]+)"/.exec(m[0])?.[1]?.replace(/^\.?\//, '')).filter((h) => h?.startsWith('assets/'));
  const onDemandKeys = new Set(ON_DEMAND.filter((s) => manifest[s]));
  const paths = {};
  for (const [name, def] of Object.entries(SHELLS)) {
    const shellKey = keyOf(def.shell);
    if (!shellKey || !manifest[shellKey].isDynamicEntry) { errors.push(`${name}: ${def.shell} is not a chunk of its own (it must be loaded with import())`); continue; }
    const missing = def.also.filter((s) => !keyOf(s));
    for (const s of missing) errors.push(`${name}: the build has no "${s}" chunk`);
    const alsoKeys = def.also.map(keyOf).filter(Boolean);
    const keys = closure([entryKey, shellKey, ...alsoKeys]);
    const js = keys.map((k) => manifest[k].file);
    // The CSS of the chunks, and each stylesheet that index.html links: a linked stylesheet blocks the first paint.
    const css = [...new Set([...keys.flatMap((k) => manifest[k].css ?? []), ...stylesheets])];
    const total = [...js, ...css].map(sizeOf).reduce(add, { raw: 0, gzip: 0, brotli: 0 });
    paths[name] = { js, css, ...total, roundTrips: roundTrips(total.brotli) };

    if (total.brotli > budgets.firstPaintBrotli[name]) errors.push(`${name}: the first-paint path is ${total.brotli} bytes brotli: over the budget of ${budgets.firstPaintBrotli[name]}`);
    if (js.length > budgets.firstPaintFiles[name]) errors.push(`${name}: the first-paint path has ${js.length} JS files: over the budget of ${budgets.firstPaintFiles[name]}`);

    // The other shell, and the chunks that load on demand.
    for (const [other, o] of Object.entries(SHELLS)) {
      if (other !== name && keys.includes(o.shell)) errors.push(`${name}: the first-paint path holds the ${other} shell (${manifest[o.shell].file})`);
    }
    const allowed = new Set(alsoKeys);
    for (const k of keys) {
      if (onDemandKeys.has(k) && !allowed.has(k)) errors.push(`${name}: the first-paint path holds ${k} (${manifest[k].file}), which must load on demand`);
      if (ON_DEMAND_NAMES.includes(manifest[k].name) && !manifest[k].src && !allowed.has(k)) errors.push(`${name}: the first-paint path holds the "${manifest[k].name}" chunk (${manifest[k].file}), which must load on demand`);
    }
    // No waterfall: each file is in index.html for this width.
    for (const file of [...js, ...css]) {
      if (!announced.some((a) => a.href === file && mediaApplies(a.media, def.media))) errors.push(`${name}: ${file} is in the first-paint path, and index.html does not announce it for a width of ${def.media}px (one more round trip)`);
    }
    // And index.html announces nothing else for this width (a preload of an on-demand chunk is a download the first screen does not need).
    for (const a of announced) {
      if (!a.href.startsWith('assets/') || !mediaApplies(a.media, def.media)) continue;
      if (!js.includes(a.href) && !css.includes(a.href)) errors.push(`${name}: index.html announces ${a.href} for a width of ${def.media}px, and it is not in the first-paint path`);
    }
  }

  const chunks = Object.entries(manifest).filter(([, c]) => c.file.endsWith('.js')).map(([key, c]) => ({ key, file: c.file, ...sizeOf(c.file), entry: !!c.isEntry, dynamic: !!c.isDynamicEntry }));
  const report = { entry: { file: entry.file, ...entrySize }, chunkCount: chunks.length, paths, chunks: chunks.sort((a, b) => b.brotli - a.brotli), budgets };
  return { ok: errors.length === 0, errors, report };
}

const kb = (n) => `${(n / 1000).toFixed(1)} kB`;
export function formatReport(report) {
  const lines = [];
  lines.push(`entry ${report.entry.file}: ${kb(report.entry.raw)} raw, ${kb(report.entry.gzip)} gzip, ${kb(report.entry.brotli)} brotli (budget ${kb(report.budgets.entryGzip)} gzip)`);
  lines.push(`JS chunks: ${report.chunkCount}`);
  for (const [name, p] of Object.entries(report.paths)) {
    lines.push(`first paint, ${name}: ${p.js.length} JS + ${p.css.length} CSS files, ${kb(p.raw)} raw, ${kb(p.gzip)} gzip, ${kb(p.brotli)} brotli (budget ${kb(report.budgets.firstPaintBrotli[name])}), about ${p.roundTrips} round trips of data on a new connection`);
    for (const f of [...p.js, ...p.css]) lines.push(`    ${f}`);
  }
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dist = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
  const r = checkBundle(dist);
  if (args.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    if (r.report.entry) console.log(formatReport(r.report));
    for (const e of r.errors) console.error(`check-bundle: ${e}`);
    console.log(r.ok ? 'check-bundle: OK' : `check-bundle: FAILED (${r.errors.length})`);
  }
  process.exit(r.ok ? 0 : 1);
}
