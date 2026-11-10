// packages/core/src/files/thumbnail.ts
// Small copies of images for lists (2026-11-09). The Previews screen showed every image at full size,
// and an iPhone page with 185 such images (about 1.2 GB decoded) was closed by Safari. A list now asks
// for `?thumb=480`; the daemon answers a cached JPEG no larger than that, and the viewer still opens the
// full image. The resize is macOS `sips`, which needs no package. Where it is missing or fails, the
// answer is null and the caller serves the original, as before.
//
// Final review of v4.5.0:
// - A source that is already no larger than the width gets no copy (`sips -Z` would make it LARGER).
//   The answer is null, so the caller serves the original; a marker file remembers it.
// - A failed run removes its `.tmp.jpg` file.
// - The cache has an age limit and a size limit. They are applied when a new copy is written, at most
//   once per interval. There is no timer.
// - `thumbnailHeaders` gives the cache headers of a copy: an ETag that names the version of the source,
//   and a short max-age (the URL does not change when the source does).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';

/** The widths a caller may ask for: a fixed list keeps the cache small and the input checked. */
export const THUMB_WIDTHS = [240, 480, 960] as const;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.tif', '.tiff', '.bmp']);
const SIPS = '/usr/bin/sips';
const MAX_AT_ONCE = 2;
const TIMEOUT_MS = 15_000;

/** A copy that nobody asked for in this long is removed. */
export const THUMB_MAX_AGE_MS = 30 * 86_400_000;
/** The cache folder holds at most this many bytes of copies; the ones used longest ago go first. */
export const THUMB_MAX_BYTES = 256 * 1024 * 1024;
/** The folder is read for the limits at most this often, however many copies are written. */
const PRUNE_EVERY_MS = 60_000;
/** A hit moves the copy's time forward when it is older than this, so "used longest ago" is true to a day. */
const TOUCH_AFTER_MS = 86_400_000;
/** A `.tmp.jpg` file older than this belongs to a run that died (a run is stopped after TIMEOUT_MS). */
const TMP_MAX_AGE_MS = 10 * 60_000;
/** How long a browser may show a copy before it asks again (with the ETag, so the answer is mostly 304). */
export const THUMB_BROWSER_MAX_AGE_S = 300;

// The files this module writes in its folder. Nothing else in the folder is ever removed.
const COPY = /^[0-9a-f]{32}\.jpg$/;
const MARKER = /^[0-9a-f]{32}\.orig$/;
const TMP = /^[0-9a-f]{32}\.jpg\.\d+\.tmp\.jpg$/;

export type Resize = (src: string, width: number, out: string) => Promise<void>;
/** The pixel size of an image, or null when it cannot be read. */
export type Probe = (src: string) => Promise<{ width: number; height: number } | null>;

const hasSips = (): boolean => process.platform === 'darwin' && fs.existsSync(SIPS);

/** The default resizer: `sips -Z <width> -s format jpeg <src> --out <out>` (macOS only). */
const sipsResize: Resize = (src, width, out) => new Promise((resolve, reject) => {
  if (!hasSips()) { reject(new Error('no sips')); return; }
  execFile(SIPS, ['-Z', String(width), '-s', 'format', 'jpeg', '-s', 'formatOptions', '70', src, '--out', out], { timeout: TIMEOUT_MS }, (err) => (err ? reject(err) : resolve()));
});

/** The default probe: `sips -g pixelWidth -g pixelHeight <src>` (macOS only). */
const sipsProbe: Probe = (src) => new Promise((resolve) => {
  if (!hasSips()) { resolve(null); return; }
  execFile(SIPS, ['-g', 'pixelWidth', '-g', 'pixelHeight', src], { timeout: TIMEOUT_MS }, (err, stdout) => {
    if (err) { resolve(null); return; }
    const w = /pixelWidth:\s*(\d+)/.exec(String(stdout));
    const h = /pixelHeight:\s*(\d+)/.exec(String(stdout));
    resolve(w && h ? { width: Number(w[1]), height: Number(h[1]) } : null);
  });
});

export interface Thumbnailer {
  /** The path of a JPEG no larger than `width`, or null when none can be made or none is needed (the caller serves the original). */
  thumbnail(src: string, width: number): Promise<string | null>;
}

/**
 * The cache headers of the small copy at `small` (a path that `thumbnail` returned). The copy's file
 * name is a hash of the source's path, size and change time and of the width, so the ETag changes when
 * the source changes. The URL of a copy does NOT change then, so the browser may keep it for a short
 * time only (an ETag is not asked about before max-age ends); after that it asks again and mostly
 * gets a 304. Set these before `res.sendFile`: `send` keeps an ETag that is already set.
 */
export function thumbnailHeaders(small: string): { 'Cache-Control': string; ETag: string } {
  return {
    'Cache-Control': `private, max-age=${THUMB_BROWSER_MAX_AGE_S}`,
    ETag: `"thumb-${path.basename(small, '.jpg')}"`,
  };
}

/** Apply the age limit and the size limit to the folder. `keep` (the copy just written) always stays. */
async function prune(dir: string, keep: string, maxAgeMs: number, maxBytes: number): Promise<void> {
  let names: string[];
  try { names = await fs.promises.readdir(dir); } catch { return; }
  const now = Date.now();
  const remove = async (p: string) => { try { await fs.promises.rm(p, { force: true }); } catch { /* another process removed it */ } };
  const copies: { path: string; size: number; at: number }[] = [];
  let total = 0;
  for (const name of names) {
    const tmp = TMP.test(name);
    if (!tmp && !COPY.test(name) && !MARKER.test(name)) continue;
    const p = path.join(dir, name);
    let st: fs.Stats;
    try { st = await fs.promises.stat(p); } catch { continue; }
    if (!st.isFile()) continue;
    if (p !== keep && now - st.mtimeMs > (tmp ? TMP_MAX_AGE_MS : maxAgeMs)) { await remove(p); continue; }
    if (tmp) continue; // a run of this or another process may still write it
    copies.push({ path: p, size: st.size, at: st.mtimeMs });
    total += st.size;
  }
  if (total <= maxBytes) return;
  copies.sort((a, b) => a.at - b.at);
  for (const c of copies) {
    if (total <= maxBytes) break;
    if (c.path === keep) continue;
    await remove(c.path);
    total -= c.size;
  }
}

export function createThumbnailer(opts: {
  cacheDir: string;
  run?: Resize;
  probe?: Probe;
  /** The limits of the cache folder (defaults: THUMB_MAX_BYTES, THUMB_MAX_AGE_MS). */
  maxBytes?: number;
  maxAgeMs?: number;
  /** The least time between two reads of the folder for the limits (default: one minute). */
  pruneEveryMs?: number;
}): Thumbnailer {
  const run = opts.run ?? sipsResize;
  const probe = opts.probe ?? sipsProbe;
  const maxBytes = opts.maxBytes ?? THUMB_MAX_BYTES;
  const maxAgeMs = opts.maxAgeMs ?? THUMB_MAX_AGE_MS;
  const pruneEveryMs = opts.pruneEveryMs ?? PRUNE_EVERY_MS;
  const pending = new Map<string, Promise<string | null>>();
  let live = 0;
  let prunedAt = -Infinity;
  const waiters: (() => void)[] = [];
  const slot = async () => { if (live >= MAX_AT_ONCE) await new Promise<void>((r) => waiters.push(r)); live++; };
  const release = () => { live--; waiters.shift()?.(); };

  /** True when the file is there. A hit counts as a use: an old file gets the time of now. */
  const hit = (file: string): boolean => {
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { return false; }
    const now = Date.now();
    if (now - st.mtimeMs > TOUCH_AFTER_MS) { try { fs.utimesSync(file, new Date(now), new Date(now)); } catch { /* read-only: the copy still serves */ } }
    return true;
  };

  return {
    async thumbnail(src, width) {
      if (!(THUMB_WIDTHS as readonly number[]).includes(width)) return null;
      if (!IMAGE_EXT.has(path.extname(src).toLowerCase())) return null;
      let st: fs.Stats;
      try { st = fs.statSync(src); } catch { return null; }
      if (!st.isFile()) return null;
      // The source's path, size and change time name the copy: a changed file gets a new copy.
      const key = createHash('sha256').update(`${src}\0${st.size}\0${st.mtimeMs}\0${width}`).digest('hex').slice(0, 32);
      const out = path.join(opts.cacheDir, `${key}.jpg`);
      // The marker of a source that needs no copy at this width: the original is the answer.
      const marker = path.join(opts.cacheDir, `${key}.orig`);
      if (hit(out)) return out;
      if (hit(marker)) return null;
      const running = pending.get(out);
      if (running) return running;
      const job = (async () => {
        await slot();
        const tmp = `${out}.${process.pid}.tmp.jpg`;
        try {
          fs.mkdirSync(opts.cacheDir, { recursive: true, mode: 0o700 });
          // Never larger than the source: `sips -Z 480` makes a 100 pixel image 480 pixels.
          const size = await probe(src).catch(() => null);
          if (size && Math.max(size.width, size.height) <= width) {
            fs.writeFileSync(marker, '');
            return null;
          }
          await run(src, width, tmp);
          fs.renameSync(tmp, out);
          const now = Date.now();
          if (now - prunedAt >= pruneEveryMs) {
            prunedAt = now;
            await prune(opts.cacheDir, out, maxAgeMs, maxBytes).catch(() => { /* the limits wait for the next copy */ });
          }
          return out;
        } catch {
          try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to remove */ }
          return null;
        } finally { release(); pending.delete(out); }
      })();
      pending.set(out, job);
      return job;
    },
  };
}
