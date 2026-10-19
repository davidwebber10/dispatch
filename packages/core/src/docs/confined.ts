/**
 * The one way the doc resolver reads a file from disk (PR #95 review: a symlink swap between the
 * containment check and the read must never leak a file from outside the project).
 *
 * `real` is the fully resolved path that `locate` gave, already checked to be inside `realRoot`.
 * - Check time: `lstat(real)` must be a regular file (a symlink there means the path changed after
 *   `locate`); its `dev` and `ino` are kept.
 * - Open: `real`, never the requested spelling, with O_NOFOLLOW (a final symlink is refused) and
 *   O_NONBLOCK (a FIFO swapped in never blocks the open).
 * - After the open: `fstat` of the descriptor must be a regular file with the `dev` and `ino` kept at
 *   check time (a swapped file or a swapped parent folder gives another inode), and `real` must still
 *   resolve inside `realRoot`. On any mismatch the file is closed and refused.
 * - The bytes come from the descriptor only, at most `max` + 1, so a file that grew is too large.
 *
 * A known limit: the check-time `lstat` runs as a separate path lookup after `locate`. A same-user
 * process that swaps a parent folder out before that `lstat` and back between the open and the
 * realpath re-check can still make the read return an outside file. Path-only checks cannot close
 * that window in Node. The threat model (the attacker is a process of the same user, who can already
 * read that file) makes this low severity.
 */
import fs from 'node:fs';
import path from 'node:path';
import { leadsOut } from '../overseer/source-file.js';

const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

export type Confined =
  | { kind: 'file'; bytes: Buffer; mtime: Date }
  | { kind: 'missing' }
  | { kind: 'folder' }
  /** Not a regular file (a FIFO, a device, a socket). */
  | { kind: 'not_file' }
  | { kind: 'too_large'; size: number }
  /** The path changed between the check and the read (a symlink now, or another file). */
  | { kind: 'changed' }
  /** The path no longer resolves inside the project. */
  | { kind: 'outside' };

/** Test hooks only; the route never passes them. `beforeOpen` runs between the check and the open; `afterOpen` between the open and the read. */
export interface ConfinedHooks { beforeOpen?: () => Promise<void> | void; afterOpen?: () => Promise<void> | void }

export async function readConfined(realRoot: string, real: string, max: number, hooks: ConfinedHooks = {}): Promise<Confined> {
  let checked: fs.Stats;
  try { checked = await fs.promises.lstat(real); } catch { return { kind: 'missing' }; }
  if (checked.isSymbolicLink()) return { kind: 'changed' };
  if (checked.isDirectory()) return { kind: 'folder' };
  if (!checked.isFile()) return { kind: 'not_file' };
  if (checked.size > max) return { kind: 'too_large', size: checked.size };

  await hooks.beforeOpen?.();

  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(real, OPEN_FLAGS);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    if (code === 'EISDIR') return { kind: 'folder' };
    if (code === 'EACCES' || code === 'EPERM') return { kind: 'missing' }; // not readable: reads as not found
    return { kind: 'changed' }; // ELOOP (a symlink now), or another error: never read
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { kind: 'changed' };
    if (st.dev !== checked.dev || st.ino !== checked.ino) return { kind: 'changed' };
    let again: string;
    try { again = await fs.promises.realpath(real); } catch { return { kind: 'changed' }; }
    if (leadsOut(path.relative(realRoot, again))) return { kind: 'outside' };
    if (st.size > max) return { kind: 'too_large', size: st.size };
    await hooks.afterOpen?.();
    const buf = Buffer.alloc(Math.min(st.size, max) + 1);
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    if (n > max) return { kind: 'too_large', size: Math.max(n, st.size) };
    if (n > st.size) return { kind: 'changed' }; // grew after the fstat: not a whole, consistent copy
    return { kind: 'file', bytes: buf.subarray(0, n), mtime: st.mtime };
  } finally {
    await fh.close().catch(() => { /* closing is best effort */ });
  }
}
