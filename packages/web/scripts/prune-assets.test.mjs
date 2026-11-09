import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneAssets } from './prune-assets.mjs';

describe('pruneAssets', () => {
  let dist;
  beforeEach(() => { dist = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-assets-')); fs.mkdirSync(path.join(dist, 'assets')); fs.mkdirSync(path.join(dist, '.vite')); });
  afterEach(() => { fs.rmSync(dist, { recursive: true, force: true }); });

  const assets = () => fs.readdirSync(path.join(dist, 'assets')).sort();
  /** A build as Vite leaves it: the files in dist/assets (added to what is there) and a new manifest. */
  function build(tag) {
    const files = { entry: `assets/index-${tag}.js`, css: `assets/index-${tag}.css`, chunk: `assets/NotesTab-${tag}.js`, font: `assets/plex-${tag}.woff2` };
    for (const f of Object.values(files)) fs.writeFileSync(path.join(dist, f), tag);
    // The font has one name for every build (its content does not change), as in a real build.
    fs.writeFileSync(path.join(dist, 'assets/mono-SAME.woff2'), 'font');
    fs.writeFileSync(path.join(dist, '.vite/manifest.json'), JSON.stringify({
      'index.html': { file: files.entry, isEntry: true, css: [files.css], assets: [files.font, 'assets/mono-SAME.woff2'], dynamicImports: ['src/NotesTab.tsx'] },
      'src/NotesTab.tsx': { file: files.chunk, isDynamicEntry: true, imports: ['index.html'] },
    }));
    return Object.values(files).map((f) => path.basename(f));
  }

  it('keeps current and previous build files, removes older files', () => {
    const a = build('AAA');
    pruneAssets(dist);
    expect(assets()).toEqual([...a, 'mono-SAME.woff2'].sort()); // the first build: nothing to remove

    const b = build('BBB');
    const second = pruneAssets(dist);
    expect(assets()).toEqual([...a, ...b, 'mono-SAME.woff2'].sort()); // an open tab on build A keeps its chunks
    expect(second.removed).toEqual([]);

    const c = build('CCC');
    const third = pruneAssets(dist);
    expect(assets()).toEqual([...b, ...c, 'mono-SAME.woff2'].sort()); // build A is two builds old: removed
    expect(third.removed.sort()).toEqual([...a].sort());
    expect(JSON.parse(fs.readFileSync(path.join(dist, '.vite/manifest.prev.json'), 'utf8'))['index.html'].file).toBe('assets/index-BBB.js');
  });

  it('a second run with no new build removes nothing more', () => {
    const a = build('AAA'); pruneAssets(dist);
    const b = build('BBB'); pruneAssets(dist);
    pruneAssets(dist);
    pruneAssets(dist);
    expect(assets()).toEqual([...a, ...b, 'mono-SAME.woff2'].sort());
    // The same holds for a rebuild that gives the same file names (no source change).
    build('BBB'); pruneAssets(dist);
    expect(assets()).toEqual([...a, ...b, 'mono-SAME.woff2'].sort());
  });

  it('removes a file that no manifest names', () => {
    build('AAA');
    fs.writeFileSync(path.join(dist, 'assets/index-OLD.js'), 'old');
    const r = pruneAssets(dist);
    expect(r.removed).toEqual(['index-OLD.js']);
    expect(assets()).not.toContain('index-OLD.js');
  });

  it('removes nothing when the manifest is missing or is not JSON', () => {
    build('AAA');
    fs.writeFileSync(path.join(dist, 'assets/index-OLD.js'), 'old');
    fs.writeFileSync(path.join(dist, '.vite/manifest.json'), '{ not json');
    expect(pruneAssets(dist).removed).toEqual([]);
    fs.rmSync(path.join(dist, '.vite/manifest.json'));
    expect(pruneAssets(dist).removed).toEqual([]);
    expect(assets()).toContain('index-OLD.js');
  });

  it('removes nothing when the current manifest names a file that is not in dist/assets', () => {
    // A manifest that does not match the folder means the build did not finish. Do not trust it.
    build('AAA');
    fs.writeFileSync(path.join(dist, 'assets/index-OLD.js'), 'old');
    fs.rmSync(path.join(dist, 'assets/index-AAA.js'));
    expect(pruneAssets(dist).removed).toEqual([]);
    expect(assets()).toContain('index-OLD.js');
  });

  it('touches only dist/assets', () => {
    build('AAA');
    fs.writeFileSync(path.join(dist, 'index.html'), '<html>');
    fs.writeFileSync(path.join(dist, 'sw.js'), '//');
    pruneAssets(dist);
    expect(fs.existsSync(path.join(dist, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(dist, 'sw.js'))).toBe(true);
  });
});
