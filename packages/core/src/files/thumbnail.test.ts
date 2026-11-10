import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import express from 'express';
import request from 'supertest';
import { createThumbnailer, thumbnailHeaders, THUMB_WIDTHS } from './thumbnail.js';

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

  // ── final review of v4.5.0 ──────────────────────────────────────────────────────────────
  const fakeRun = async (_src: string, _w: number, out: string) => { fs.writeFileSync(out, 'x'.repeat(1000)); };
  const big = async () => ({ width: 2000, height: 1200 });
  const source = (name: string) => { const f = path.join(dir, name); fs.writeFileSync(f, name); return f; };
  const cached = () => fs.readdirSync(cache).sort();
  const age = (file: string, ms: number) => { const at = new Date(Date.now() - ms); fs.utimesSync(file, at, at); };
  const DAY = 86_400_000;

  it('a failed run leaves no .tmp.jpg file', async () => {
    const run = async (_src: string, _w: number, out: string) => { fs.writeFileSync(out, 'half a jpeg'); throw new Error('sips was killed'); };
    const t = createThumbnailer({ cacheDir: cache, run, probe: big });
    expect(await t.thumbnail(source('a.png'), 480)).toBeNull();
    expect(cached()).toEqual([]);
  });

  it('never makes an image larger: a source no larger than the width gives null, and is measured once', async () => {
    let probes = 0; let runs = 0;
    const t = createThumbnailer({
      cacheDir: cache,
      probe: async () => { probes++; return { width: 300, height: 480 }; },
      run: async (src, w, out) => { runs++; await fakeRun(src, w, out); },
    });
    const src = source('small.png');
    expect(await t.thumbnail(src, 480)).toBeNull(); // the caller serves the original
    expect(await t.thumbnail(src, 480)).toBeNull();
    expect(runs).toBe(0);
    expect(probes).toBe(1); // the answer is remembered for this version of the source
    expect(cached().filter((n) => n.endsWith('.jpg'))).toEqual([]);
    // A smaller width still gets a small copy.
    expect(await t.thumbnail(src, 240)).not.toBeNull();
    expect(runs).toBe(1);
  });

  it('a source larger than the width, by its width or by its height, gets a small copy', async () => {
    for (const [i, d] of [{ width: 481, height: 10 }, { width: 10, height: 481 }].entries()) {
      const t = createThumbnailer({ cacheDir: cache, probe: async () => d, run: fakeRun });
      expect(await t.thumbnail(source(`large${i}.png`), 480)).not.toBeNull();
    }
  });

  it('a source that cannot be measured still goes to the resizer', async () => {
    const t = createThumbnailer({ cacheDir: cache, probe: async () => null, run: fakeRun });
    expect(await t.thumbnail(source('unknown.png'), 480)).not.toBeNull();
  });

  it.runIf(hasSips)('sips: a 100x60 image is not made into a 480 wide one', async () => {
    const small = path.join(dir, 'small.png');
    execFileSync('/usr/bin/sips', ['-z', '60', '100', path.join(dir, 'tiny.png'), '--out', small], { stdio: 'ignore' });
    const t = createThumbnailer({ cacheDir: cache });
    expect(await t.thumbnail(small, 480)).toBeNull();
    expect(cached().filter((n) => n.endsWith('.jpg'))).toEqual([]);
    expect(await t.thumbnail(png, 480)).not.toBeNull(); // the 2000x1200 one still gets its copy
  });

  describe('the cache is pruned when a new copy is written (no timer)', () => {
    it('removes the copies older than the age limit', async () => {
      const t = createThumbnailer({ cacheDir: cache, run: fakeRun, probe: big, maxAgeMs: 30 * DAY, pruneEveryMs: 0 });
      const old = await t.thumbnail(source('old.png'), 480);
      const recent = await t.thumbnail(source('recent.png'), 480);
      age(old!, 31 * DAY); age(recent!, 29 * DAY);
      const fresh = await t.thumbnail(source('fresh.png'), 480);
      expect(fs.existsSync(old!)).toBe(false);
      expect(fs.existsSync(recent!)).toBe(true);
      expect(fs.existsSync(fresh!)).toBe(true);
    });

    it('keeps the cache under the size limit: the copies used longest ago go first, the new one stays', async () => {
      // Each copy is 1000 bytes; the limit holds three.
      const t = createThumbnailer({ cacheDir: cache, run: fakeRun, probe: big, maxBytes: 3500, pruneEveryMs: 0 });
      const made: string[] = [];
      for (let i = 0; i < 3; i++) { made.push((await t.thumbnail(source(`s${i}.png`), 480))!); age(made[i], (10 - i) * DAY); }
      // A hit on the oldest copy counts as a use: it becomes the newest.
      expect(await t.thumbnail(path.join(dir, 's0.png'), 480)).toBe(made[0]);
      const fourth = await t.thumbnail(source('s3.png'), 480);
      expect(fs.existsSync(made[0])).toBe(true);  // used a moment ago
      expect(fs.existsSync(made[1])).toBe(false); // the one used longest ago
      expect(fs.existsSync(made[2])).toBe(true);
      expect(fs.existsSync(fourth!)).toBe(true);
      expect(cached().filter((n) => n.endsWith('.jpg'))).toHaveLength(3);
    });

    it('removes a .tmp.jpg file that a dead run left, and leaves files that are not its own', async () => {
      const dead = path.join(cache, `${'a'.repeat(32)}.jpg.99999.tmp.jpg`);
      const young = path.join(cache, `${'b'.repeat(32)}.jpg.99998.tmp.jpg`);
      const foreign = path.join(cache, 'notes.txt');
      for (const f of [dead, young, foreign]) fs.writeFileSync(f, 'x');
      age(dead, DAY); age(foreign, 400 * DAY);
      const t = createThumbnailer({ cacheDir: cache, run: fakeRun, probe: big, pruneEveryMs: 0 });
      await t.thumbnail(source('n.png'), 480);
      expect(fs.existsSync(dead)).toBe(false);
      expect(fs.existsSync(young)).toBe(true); // a run of another process may still write it
      expect(fs.existsSync(foreign)).toBe(true);
    });

    it('does not read the folder again for each copy (at most once per interval)', async () => {
      const t = createThumbnailer({ cacheDir: cache, run: fakeRun, probe: big, maxBytes: 1500, pruneEveryMs: 60_000 });
      const first = await t.thumbnail(source('p0.png'), 480); // prunes (nothing to remove)
      const second = await t.thumbnail(source('p1.png'), 480); // over the limit, but inside the interval
      expect(fs.existsSync(first!)).toBe(true);
      expect(fs.existsSync(second!)).toBe(true);
    });
  });

  describe('thumbnailHeaders: the cache headers of a small copy', () => {
    it('the ETag names the version of the source, so a changed source is a different ETag', async () => {
      const t = createThumbnailer({ cacheDir: cache, run: fakeRun, probe: big });
      const src = source('v.png');
      const a = await t.thumbnail(src, 480);
      fs.utimesSync(src, new Date(), new Date(Date.now() + 5000));
      const b = await t.thumbnail(src, 480);
      const ha = thumbnailHeaders(a!); const hb = thumbnailHeaders(b!);
      expect(ha.ETag).toMatch(/^"thumb-[0-9a-f]{32}"$/);
      expect(hb.ETag).not.toBe(ha.ETag);
      expect(thumbnailHeaders(a!).ETag).toBe(ha.ETag); // stable for one version
      // Another width of the same source is another ETag.
      expect(thumbnailHeaders((await t.thumbnail(src, 240))!).ETag).not.toBe(hb.ETag);
    });

    // The route's use (routes/plugins.ts): `res.set(thumbnailHeaders(small))` before `res.sendFile(small)`.
    it('sendFile keeps these headers, and answers 304 to the ETag of the same version only', async () => {
      const t = createThumbnailer({ cacheDir: cache, run: fakeRun, probe: big });
      const src = source('route.png');
      const app = express();
      app.get('/thumb', async (_req, res) => {
        const small = await t.thumbnail(src, 480);
        res.set(thumbnailHeaders(small!));
        res.type('image/jpeg');
        res.sendFile(small!);
      });
      const first = await request(app).get('/thumb');
      expect(first.status).toBe(200);
      expect(first.headers.etag).toMatch(/^"thumb-[0-9a-f]{32}"$/);
      expect(first.headers['cache-control']).toBe(thumbnailHeaders('x.jpg')['Cache-Control']);
      expect((await request(app).get('/thumb').set('If-None-Match', first.headers.etag)).status).toBe(304);
      fs.utimesSync(src, new Date(), new Date(Date.now() + 5000)); // the source changes
      const changed = await request(app).get('/thumb').set('If-None-Match', first.headers.etag);
      expect(changed.status).toBe(200);
      expect(changed.headers.etag).not.toBe(first.headers.etag);
    });

    it('the browser may keep a copy for a short time only, then it asks again with the ETag', () => {
      const h = thumbnailHeaders(path.join(cache, `${'c'.repeat(32)}.jpg`));
      const maxAge = Number(/max-age=(\d+)/.exec(h['Cache-Control'])![1]);
      expect(h['Cache-Control']).toMatch(/^private, /);
      expect(maxAge).toBeLessThanOrEqual(300); // not a day: the URL does not change with the source
    });
  });
});
