// packages/web/scripts/prune-assets.mjs
// Runs after `vite build` (W1-E). The build no longer empties `dist` (vite.config.ts,
// `emptyOutDir: false`), so a browser tab that loaded the last build can still fetch its lazy chunks
// after a rebuild. This script stops `dist/assets` from growing without end: it keeps the files of the
// current build and of the build before it, and removes every other file in `dist/assets`.
//
// Files in dist/.vite:
//   manifest.json       the current build (Vite writes it; `build.manifest: true`)
//   manifest.prev.json  the build before the current one
//   manifest.seen.json  the manifest at the last run of this script. It tells a new build from a second
//                       run on the same build, so a second run does not drop the previous build.
//
// It removes nothing when the current manifest is missing, is not JSON, or names a file that is not in
// dist/assets (a build that did not finish).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function readManifest(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(text);
    return json && typeof json === 'object' && !Array.isArray(json) ? { text, json } : null;
  } catch { return null; }
}

/** The names in dist/assets that a manifest refers to (entry and chunk files, their CSS and their assets). */
function assetNames(manifest) {
  const names = new Set();
  const add = (f) => { if (typeof f === 'string' && f.startsWith('assets/') && !f.slice(7).includes('/')) names.add(f.slice(7)); };
  for (const chunk of Object.values(manifest)) {
    if (!chunk || typeof chunk !== 'object') continue;
    add(chunk.file);
    for (const f of Array.isArray(chunk.css) ? chunk.css : []) add(f);
    for (const f of Array.isArray(chunk.assets) ? chunk.assets : []) add(f);
  }
  return names;
}

/** @returns {{ kept: string[], removed: string[], skipped?: string }} */
export function pruneAssets(distDir) {
  const assetsDir = path.join(distDir, 'assets');
  const viteDir = path.join(distDir, '.vite');
  const current = readManifest(path.join(viteDir, 'manifest.json'));
  if (!current) return { kept: [], removed: [], skipped: 'no readable dist/.vite/manifest.json' };
  let present;
  try { present = fs.readdirSync(assetsDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name); }
  catch { return { kept: [], removed: [], skipped: 'no dist/assets' }; }

  const keep = assetNames(current.json);
  const missing = [...keep].filter((n) => !present.includes(n));
  if (missing.length) return { kept: [], removed: [], skipped: `the manifest names files that are not in dist/assets: ${missing.join(', ')}` };

  // A new build: the manifest of the last run becomes the previous build.
  const seenFile = path.join(viteDir, 'manifest.seen.json');
  const prevFile = path.join(viteDir, 'manifest.prev.json');
  const seen = readManifest(seenFile);
  if (seen && seen.text !== current.text) fs.writeFileSync(prevFile, seen.text);
  fs.writeFileSync(seenFile, current.text);

  const prev = readManifest(prevFile);
  if (prev) for (const n of assetNames(prev.json)) keep.add(n);

  const removed = [];
  for (const name of present) {
    if (keep.has(name)) continue;
    fs.rmSync(path.join(assetsDir, name), { force: true });
    removed.push(name);
  }
  return { kept: present.filter((n) => keep.has(n)), removed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
  const r = pruneAssets(dist);
  console.log(r.skipped
    ? `prune-assets: removed nothing (${r.skipped})`
    : `prune-assets: kept ${r.kept.length} files (this build and the build before it), removed ${r.removed.length}`);
}
