// packages/core/src/files/thumbnail.ts
// Small copies of images for lists (2026-11-09). The Previews screen showed every image at full size,
// and an iPhone page with 185 such images (about 1.2 GB decoded) was closed by Safari. A list now asks
// for `?thumb=480`; the daemon answers a cached JPEG no wider than that, and the viewer still opens the
// full image. The resize is macOS `sips`, which needs no package. Where it is missing or fails, the
// answer is null and the caller serves the original, as before.
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

export type Resize = (src: string, width: number, out: string) => Promise<void>;

/** The default resizer: `sips -Z <width> -s format jpeg <src> --out <out>` (macOS only). */
const sipsResize: Resize = (src, width, out) => new Promise((resolve, reject) => {
  if (process.platform !== 'darwin' || !fs.existsSync(SIPS)) { reject(new Error('no sips')); return; }
  execFile(SIPS, ['-Z', String(width), '-s', 'format', 'jpeg', '-s', 'formatOptions', '70', src, '--out', out], { timeout: TIMEOUT_MS }, (err) => (err ? reject(err) : resolve()));
});

export interface Thumbnailer {
  /** The path of a JPEG no wider than `width`, or null when none can be made (the caller serves the original). */
  thumbnail(src: string, width: number): Promise<string | null>;
}

export function createThumbnailer(opts: { cacheDir: string; run?: Resize }): Thumbnailer {
  const run = opts.run ?? sipsResize;
  const pending = new Map<string, Promise<string | null>>();
  let live = 0;
  const waiters: (() => void)[] = [];
  const slot = async () => { if (live >= MAX_AT_ONCE) await new Promise<void>((r) => waiters.push(r)); live++; };
  const release = () => { live--; waiters.shift()?.(); };

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
      if (fs.existsSync(out)) return out;
      const running = pending.get(out);
      if (running) return running;
      const job = (async () => {
        await slot();
        try {
          fs.mkdirSync(opts.cacheDir, { recursive: true, mode: 0o700 });
          const tmp = `${out}.${process.pid}.tmp.jpg`;
          await run(src, width, tmp);
          fs.renameSync(tmp, out);
          return out;
        } catch { return null; } finally { release(); pending.delete(out); }
      })();
      pending.set(out, job);
      return job;
    },
  };
}
