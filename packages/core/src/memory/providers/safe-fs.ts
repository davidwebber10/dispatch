import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

/**
 * File access for the memory providers (spec 2026-11-17-memory-design.md, 4.8). A harness's memory
 * folder is written by agents, so every read and write here:
 *   - stays inside the provider's root (the real path of each parent folder is checked);
 *   - opens the file itself with O_NOFOLLOW and checks the OPEN descriptor (a plain file), never
 *     lstat-then-read, so a link swapped in between is not followed (under privilege separation the
 *     daemon is root);
 *   - writes a new temp file (O_EXCL, O_NOFOLLOW) in the same folder and renames it over the target.
 */

export const MAX_ENTRY_BYTES = 256 * 1024;
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
const CREATE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);

export const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

export class OutsideRootError extends Error {}

const inside = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * `root/rel` when its folder's real path is inside the root's real path, else null (also when the
 * root or the folder does not exist). The final name is not resolved: the open refuses a link there.
 */
export function resolveInside(root: string, rel: string): string | null {
  if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).some((p) => p === '..' || p === '')) return null;
  const target = path.join(root, rel);
  try {
    const realRoot = fs.realpathSync(root);
    const realDir = fs.realpathSync(path.dirname(target));
    return inside(realDir, realRoot) ? path.join(realDir, path.basename(target)) : null;
  } catch { return null; }
}

/** The text and mtime of a plain file inside the root; null when it is missing, a link, not a file, or too large. */
export function readInside(root: string, rel: string): { text: string; mtimeMs: number } | null {
  const file = resolveInside(root, rel);
  if (!file) return null;
  let fd: number;
  try { fd = fs.openSync(file, READ_FLAGS); } catch { return null; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_ENTRY_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return { text: buf.subarray(0, off).toString('utf8'), mtimeMs: st.mtimeMs };
  } finally { fs.closeSync(fd); }
}

/** The plain files (not links) of a folder inside the root whose names pass `keep`, sorted. */
export function listInside(root: string, relDir: string, keep: (name: string) => boolean): string[] {
  const dir = relDir ? resolveInside(root, relDir) : (() => { try { return fs.realpathSync(root); } catch { return null; } })();
  if (!dir) return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && keep(d.name))
      .map((d) => (relDir ? `${relDir}/${d.name}` : d.name))
      .sort();
  } catch { return []; }
}

/** Write `text` to root/rel through a temp file and a rename. The folder must exist inside the root. */
export function writeInside(root: string, rel: string, text: string): void {
  const file = resolveInside(root, rel);
  if (!file) throw new OutsideRootError(`not inside the memory folder: ${rel}`);
  if (Buffer.byteLength(text, 'utf8') > MAX_ENTRY_BYTES) throw new Error('the entry is too large');
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, CREATE_FLAGS, 0o600);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try {
    // A link put at the target meanwhile is replaced by the rename itself, never written through.
    fs.renameSync(tmp, file);
  } catch (err) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw err; }
}

/** Remove root/rel when it is a plain file or a link (a link is removed, never followed). */
export function removeInside(root: string, rel: string): boolean {
  const file = resolveInside(root, rel);
  if (!file) return false;
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

/** Make the folder (and its parents) when the existing part of the path is inside `base`. */
export function ensureDirInside(base: string, dir: string): boolean {
  try {
    const realBase = fs.realpathSync(base);
    let probe = dir;
    while (!fs.existsSync(probe)) probe = path.dirname(probe);
    if (!inside(fs.realpathSync(probe), realBase)) return false;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return inside(fs.realpathSync(dir), realBase);
  } catch { return false; }
}
