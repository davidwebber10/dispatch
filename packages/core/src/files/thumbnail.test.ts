import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createThumbnailer, THUMB_WIDTHS } from './thumbnail.js';

// 2026-11-09: the Previews screen decoded 185 full-size images (about 1.2 GB) and an iPhone closed the
// page. Cards now show a small copy; the viewer still opens the full image.
const hasSips = process.platform === 'darwin' && fs.existsSync('/usr/bin/sips');

describe('createThumbnailer', () => {
  let dir: string; let cache: string; let png: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-src-'));
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-cache-'));
    png = path.join(dir, 'big.png');
    if (hasSips) {
      // A 2000x1200 PNG made by sips from a tiny one, so the test needs no image library.
      fs.writeFileSync(path.join(dir, 'tiny.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
      execFileSync('/usr/bin/sips', ['-z', '1200', '2000', path.join(dir, 'tiny.png'), '--out', png], { stdio: 'ignore' });
    }
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(cache, { recursive: true, force: true }); });

  it('only known widths are allowed', () => {
    expect(THUMB_WIDTHS).toContain(480);
  });

  it.runIf(hasSips)('makes a JPEG no wider than asked, caches it, and makes it again when the source changes', async () => {
    const t = createThumbnailer({ cacheDir: cache });
    const a = await t.thumbnail(png, 480);
    expect(a).not.toBeNull();
    const w = Number(execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', a!]).toString().match(/pixelWidth: (\d+)/)![1]);
    expect(w).toBeLessThanOrEqual(480);
    expect(fs.statSync(a!).size).toBeLessThan(fs.statSync(png).size + 1);
    const again = await t.thumbnail(png, 480);
    expect(again).toBe(a); // cached
    fs.utimesSync(png, new Date(), new Date(Date.now() + 5000));
    const changed = await t.thumbnail(png, 480);
    expect(changed).not.toBe(a);
  });

  it('a width that is not allowed, a non-image and a missing file give null (the caller serves the original)', async () => {
    const t = createThumbnailer({ cacheDir: cache });
    expect(await t.thumbnail(png, 999)).toBeNull();
    fs.writeFileSync(path.join(dir, 'a.md'), '# x');
    expect(await t.thumbnail(path.join(dir, 'a.md'), 480)).toBeNull();
    expect(await t.thumbnail(path.join(dir, 'nope.png'), 480)).toBeNull();
  });

  it('a failing resizer gives null, not an error', async () => {
    const t = createThumbnailer({ cacheDir: cache, run: async () => { throw new Error('sips failed'); } });
    fs.writeFileSync(path.join(dir, 'x.png'), 'not really a png');
    expect(await t.thumbnail(path.join(dir, 'x.png'), 480)).toBeNull();
  });

  it('runs at most two resizes at once', async () => {
    let live = 0; let peak = 0;
    const run = async (_src: string, _w: number, out: string) => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 20)); fs.writeFileSync(out, 'jpg'); live--; };
    const t = createThumbnailer({ cacheDir: cache, run });
    const files = Array.from({ length: 6 }, (_, i) => { const f = path.join(dir, `f${i}.png`); fs.writeFileSync(f, String(i)); return f; });
    const out = await Promise.all(files.map((f) => t.thumbnail(f, 480)));
    expect(out.every((p) => p !== null)).toBe(true);
    expect(peak).toBe(2);
  });
});
