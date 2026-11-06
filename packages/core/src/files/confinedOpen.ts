/**
 * Open a file inside a project so that a symlink or a folder swapped in after the containment check can
 * never make the descriptor point at a file outside it (file-chip review, rounds 2 and 3).
 *
 * Node has no openat, so the walk cannot be anchored to a folder handle. This does the next best things:
 * - `real` is the fully resolved path. Every folder on the way (from the root of the volume down) must be a
 *   real folder, not a link; its `dev` and `ino` are pinned before the open (`pinChain`).
 * - The file is opened with O_NOFOLLOW and O_NONBLOCK, and the descriptor must be the file `lstat` saw.
 * - After the open, the folders are looked at again (`sameChain`), then the file by path, then the folders again:
 *   all must be the same, and the file by path must be the very file the descriptor holds. A folder swapped
 *   for a link before the open and put back after it makes the file by path another file, so the open is refused.
 * - On Linux the kernel also says where the descriptor really is (/proc/self/fd), and that must be `real`.
 * - Any metadata that cannot be read fails closed.
 *
 * Known limit (macOS, where no call tells a descriptor's path): a same-user process that flips a folder
 * to a link and back twice, in step with these checks, within a few microseconds. Path checks cannot close
 * that in Node; the attacker would already need to run as the user who can read that file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { insideRealRoot } from './confine.js';

export interface Pin { p: string; dev: number; ino: number }

/** Every folder from the volume root down to the parent of `real`, as { path, dev, ino }. Null when one is a link, not a folder, or unreadable. */
export async function pinChain(real: string): Promise<Pin[] | null> {
  const dirs: string[] = [];
  for (let d = path.dirname(real); ; d = path.dirname(d)) {
    dirs.unshift(d);
    if (path.dirname(d) === d) break;
  }
  const pins: Pin[] = [];
  for (const d of dirs) {
    try {
      const st = await fs.promises.lstat(d);
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
      pins.push({ p: d, dev: st.dev, ino: st.ino });
    } catch { return null; }
  }
  return pins;
}

/** True when every pinned folder is still the same real folder. */
export async function sameChain(pins: Pin[]): Promise<boolean> {
  for (const pin of pins) {
    try {
      const st = await fs.promises.lstat(pin.p);
      if (st.isSymbolicLink() || !st.isDirectory() || st.dev !== pin.dev || st.ino !== pin.ino) return false;
    } catch { return false; }
  }
  return true;
}

export type Opened =
  | { kind: 'file'; fh: fs.promises.FileHandle; st: fs.Stats }
  | { kind: 'missing' }
  /** The path leads out of the project, or changed while it was opened. */
  | { kind: 'outside' };

/** Test hook only: where the descriptor really is (Linux). */
async function descriptorPath(fd: number): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  try { return (await fs.promises.readlink(`/proc/self/fd/${fd}`)).replace(/ \(deleted\)$/, ''); } catch { return ''; }
}

/** Open `target` (a path the route resolved) for reading, confined to the project `workingDir`. The caller closes `fh`. */
export async function openInside(workingDir: string, target: string, extraFlags = 0): Promise<Opened> {
  let real: string;
  try { real = await fs.promises.realpath(target); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'missing' } : { kind: 'outside' };
  }
  if (!insideRealRoot(workingDir, real)) return { kind: 'outside' };
  const pins = await pinChain(real);
  if (!pins) return { kind: 'outside' };
  let checked: fs.Stats;
  try { checked = await fs.promises.lstat(real); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'missing' } : { kind: 'outside' };
  }
  if (checked.isSymbolicLink()) return { kind: 'outside' };

  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(real, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0) | extraFlags);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    if (code === 'ELOOP') return { kind: 'outside' };
    throw e;
  }
  const refuse = async (): Promise<Opened> => { await fh.close().catch(() => { /* best effort */ }); return { kind: 'outside' }; };
  try {
    const st = await fh.stat();
    if (st.dev !== checked.dev || st.ino !== checked.ino) return await refuse();
    if (!(await sameChain(pins))) return await refuse();
    let again: fs.Stats;
    try { again = await fs.promises.lstat(real); } catch { return await refuse(); }
    if (again.isSymbolicLink() || again.dev !== st.dev || again.ino !== st.ino) return await refuse();
    if (!(await sameChain(pins))) return await refuse();
    const where = await descriptorPath(fh.fd);
    if (where !== null && where !== real) return await refuse();
    if (!insideRealRoot(workingDir, real)) return await refuse();
    return { kind: 'file', fh, st };
  } catch {
    return await refuse();
  }
}
