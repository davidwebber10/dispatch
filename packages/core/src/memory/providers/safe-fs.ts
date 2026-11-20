import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { privsep, type PrivsepConfig } from '../../privsep/config.js';
import { agentListFiles, agentMkdir, agentReadFileSync, agentRemove, agentRename, agentWriteFile } from '../../privsep/agent-fs.js';

/**
 * File access for the memory providers (spec 2026-11-17-memory-design.md, 4.8). A harness's memory
 * folder is written by agents, and an agent can replace the file OR ANY FOLDER on its path with a link.
 *
 *   - Under privilege separation (the daemon is root) every read, list, write, rename, delete and mkdir
 *     runs AS THE AGENT (privsep/agent-fs.ts): the kernel applies the agent's rights to every part of the
 *     path, so a link to a root-only place (the state root) leads nowhere the agent could not read.
 *   - Everywhere, as defense in depth: the real path of the target's folder must be inside the real path
 *     of the provider root, before the operation and again after it (a folder swapped for a link during
 *     a read makes the read refused); the file itself is opened with O_NOFOLLOW and checked on the open
 *     descriptor (never lstat-then-read); a write goes to a new temp file (exclusive) and is renamed.
 */

export const MAX_ENTRY_BYTES = 256 * 1024;

export const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

export class OutsideRootError extends Error {}

/**
 * A provider's folder (`dir`) and the TRUSTED folder it must stay in (`base`: the person's home, or a
 * folder the daemon's own environment names). The check is against both real paths, so a provider
 * folder that is itself a link to somewhere else (the state root) is refused.
 */
export interface Root { dir: string; base: string }

/** Test seams: force the agent path (as on a box), and run code between the path check and the open. */
export const safeFsTest: { mode: PrivsepConfig | null | undefined; beforeOpen: ((file: string) => void) | null } = { mode: undefined, beforeOpen: null };
const cfg = (): PrivsepConfig | null => (safeFsTest.mode !== undefined ? safeFsTest.mode : privsep());

const inside = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const realDirOf = (root: Root, dir: string): string | null => {
  try {
    const realBase = fs.realpathSync(root.base);
    const realRoot = fs.realpathSync(root.dir);
    const realDir = fs.realpathSync(dir);
    return inside(realRoot, realBase) && inside(realDir, realRoot) ? realDir : null;
  } catch { return null; }
};

/**
 * `root/rel` with its folder resolved to a real path inside the root's real path, else null (also when
 * the root or the folder does not exist). The final name is not resolved: the open refuses a link there.
 */
export function resolveInside(root: Root, rel: string): string | null {
  if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).some((p) => p === '..' || p === '' || p === '.')) return null;
  const target = path.join(root.dir, rel);
  const realDir = realDirOf(root, path.dirname(target));
  return realDir ? path.join(realDir, path.basename(target)) : null;
}

/** The folder still is the real folder that was checked (no link swapped in meanwhile). */
const stillThere = (root: Root, file: string): boolean => realDirOf(root, path.dirname(file)) === path.dirname(file);

/** The text and mtime of a plain file inside the root; null when missing, a link (at any part), not a file, outside, or too large. */
export function readInside(root: Root, rel: string): { text: string; mtimeMs: number } | null {
  const file = resolveInside(root, rel);
  if (!file) return null;
  safeFsTest.beforeOpen?.(file);
  const got = agentReadFileSync(file, MAX_ENTRY_BYTES, cfg());
  return got && stillThere(root, file) ? got : null;
}

/** The plain files (not links) of a folder inside the root whose names pass `keep`, sorted. */
export function listInside(root: Root, relDir: string, keep: (name: string) => boolean): string[] {
  const dir = relDir ? resolveInside(root, relDir) : realDirOf(root, root.dir);
  if (!dir) return [];
  const names = agentListFiles(dir, cfg()).filter(keep).sort();
  if (!names.length || (relDir ? !stillThere(root, path.join(dir, 'x')) : realDirOf(root, root.dir) !== dir)) return [];
  return names.map((n) => (relDir ? `${relDir}/${n}` : n));
}

/** Write `text` to root/rel through a new temp file and a rename. The folder must exist inside the root. */
export function writeInside(root: Root, rel: string, text: string): void {
  const file = resolveInside(root, rel);
  if (!file) throw new OutsideRootError(`not inside the memory folder: ${rel}`);
  if (Buffer.byteLength(text, 'utf8') > MAX_ENTRY_BYTES) throw new Error('the entry is too large');
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  const c = cfg();
  if (c) {
    agentWriteFile(tmp, text, { flag: 'wx', mode: 0o600 }, c);
  } else {
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  try {
    if (!stillThere(root, file)) throw new OutsideRootError(`the memory folder changed: ${rel}`);
    // A link put at the target meanwhile is replaced by the rename itself, never written through.
    agentRename(tmp, file, c);
  } catch (err) { try { agentRemove(tmp, {}, c); } catch { /* gone */ } throw err; }
}

/** Remove root/rel (a link is removed, never followed). */
export function removeInside(root: Root, rel: string): boolean {
  const file = resolveInside(root, rel);
  if (!file) return false;
  try { agentRemove(file, {}, cfg()); return true; } catch { return false; }
}

/** Make the folder (and its parents) when the existing part of the path is inside `base`. */
export function ensureDirInside(base: string, dir: string): boolean {
  try {
    const realBase = fs.realpathSync(base);
    let probe = dir;
    while (!fs.existsSync(probe)) probe = path.dirname(probe);
    if (!inside(fs.realpathSync(probe), realBase)) return false;
    agentMkdir(dir, cfg());
    return inside(fs.realpathSync(dir), realBase);
  } catch { return false; }
}
