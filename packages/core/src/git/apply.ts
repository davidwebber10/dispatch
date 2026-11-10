/**
 * Approve and Discard for the diff review (engineering program W3-G).
 *
 * The rule of this file: an action touches the files the page named, and no other file.
 *   - Every path passes `confine` (text, real location, credential list) AND must be one of the changed files that
 *     git lists right now. A folder, `.`, a glob or an unchanged file is not in that list, so it is refused.
 *   - All paths are checked before the first file is touched. One bad path refuses the whole call.
 *   - The place of each path on the disk must be able to hold a file (`checkPlace`, v4.5.0 review I5). `git restore`
 *     and `git add` act on whatever stands at the path: a folder that took the place of a deleted file is REMOVED by
 *     a restore, with every file in it (the ignored ones too), and is staged whole by an add. Such a path is refused.
 *   - git gets each path after `--`, with pathspec magic off (`--literal-pathspecs` in exec.ts).
 *   - There is no `git reset --hard`, no `git checkout -- .`, no `git clean` and no `git stash` here, and none may
 *     be added. Discard uses `git restore` on one file, `git rm --cached` on one file and `unlink` on one file.
 *   - Approve is `git add` on the listed files. It makes no commit.
 *   - Before a discard, the content of the file goes into the git object store (`git hash-object -w`). The answer
 *     carries the object id, so `git cat-file -p <id>` gives the content back until git prunes it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { git, gitOrNull, isLockError } from './exec.js';
import { confine, PathRefused } from './paths.js';
import { listChanges, isRepo, type Change } from './diff.js';
import type { SecretRoots } from '../files/secret-paths.js';

export const MAX_PATHS = 2000;
const BACKUP_MAX_BYTES = 50 * 1024 * 1024;
const CHUNK = 200;

export interface ApproveResult { staged: string[] }
export interface DiscardResult {
  /** `backup` is the git object that holds the content from before the discard (absent for a deleted file). */
  discarded: Array<{ path: string; backup?: string }>;
  /** A file that git or the disk refused. The files before it are done; the files after it are not touched. */
  errors: Array<{ path: string; error: string }>;
}

interface Target { change: Change; abs: string; oldAbs?: string }

async function lstatOrNull(p: string): Promise<fs.Stats | null> {
  try { return await fs.promises.lstat(p); } catch { return null; }
}

/**
 * The place of `rel` on the disk must be able to hold that one file. Throws `PathRefused` when:
 *   - a folder stands at the path (a tracked file was deleted and a folder with that name was made). A restore of
 *     the file removes the folder and all that is in it; an add stages the files in it;
 *   - a part of the path that must be a folder is a file (a folder was replaced by a file). A restore of a file
 *     below it removes that file to make the folder.
 * A path with nothing at it, or with missing folders above it, is fine: a restore only creates there.
 */
async function checkPlace(abs: string, rel: string): Promise<void> {
  if ((await lstatOrNull(abs))?.isDirectory()) {
    throw new PathRefused(`"${rel}" is a folder now, not a file. Dispatch does not stage or remove a folder. Move the folder away, then refresh the review.`);
  }
  // The nearest part above it that exists. `confine` already refused a symbolic link there.
  for (let p = path.dirname(abs); ; p = path.dirname(p)) {
    const st = await lstatOrNull(p);
    if (st) {
      if (!st.isDirectory()) throw new PathRefused(`"${rel}" is below "${path.basename(p)}", which is not a folder now. Dispatch does not replace a file with a folder. Refresh the review.`);
      return;
    }
    if (path.dirname(p) === p) return;
  }
}

/** Check every path, then return the changes they name. Throws `PathRefused` and touches nothing. */
async function targetsOf(workDir: string, paths: unknown, roots: SecretRoots | undefined): Promise<Target[]> {
  if (!Array.isArray(paths) || paths.length === 0) throw new PathRefused('Give the paths of the files as a non-empty list.', 400);
  if (paths.length > MAX_PATHS) throw new PathRefused(`At most ${MAX_PATHS} files in one call.`, 400);
  if (!(await isRepo(workDir))) throw new PathRefused('The working directory is not in a git repository.', 400);
  const abs = new Map<string, string>();
  for (const p of paths) {
    if (typeof p !== 'string') throw new PathRefused('A path must be a string.', 400);
    if (!abs.has(p)) abs.set(p, await confine(workDir, p, roots));
  }
  const changed = new Map((await listChanges(workDir)).map((c) => [c.path, c]));
  const targets: Target[] = [];
  for (const [p, a] of abs) {
    const change = changed.get(p);
    if (!change) throw new PathRefused(`"${p}" is not a changed file in this directory. Refresh the review and try again.`);
    if (change.directory) throw new PathRefused(`"${p}" is a folder with its own git repository. Dispatch does not stage or remove it.`);
    const oldAbs = change.oldPath ? await confine(workDir, change.oldPath, roots) : undefined;
    await checkPlace(a, p);
    if (oldAbs && change.oldPath) await checkPlace(oldAbs, change.oldPath);
    targets.push({ change, abs: a, ...(oldAbs ? { oldAbs } : {}) });
  }
  return targets;
}

const busy = (e: unknown): Error => (isLockError(e) ? new Error('Another git command runs in this directory now. Try again in a moment.') : (e as Error));

/** Stage the listed files (`git add`). No commit. */
export async function approvePaths(workDir: string, paths: unknown, roots?: SecretRoots): Promise<ApproveResult> {
  const targets = await targetsOf(workDir, paths, roots);
  // A rename is two paths in the index: the new one and the removal of the old one.
  const all = targets.flatMap((t) => (t.change.oldPath ? [t.change.oldPath, t.change.path] : [t.change.path]));
  try {
    for (let i = 0; i < all.length; i += CHUNK) await git(workDir, ['add', '--', ...all.slice(i, i + CHUNK)], { write: true });
  } catch (e) { throw busy(e); }
  return { staged: targets.map((t) => t.change.path) };
}

/** Put the file's content in the object store. Best effort: a link, a folder or a very large file has no copy. */
async function backup(workDir: string, t: Target): Promise<string | undefined> {
  const st = await lstatOrNull(t.abs);
  if (!st || !st.isFile() || st.size > BACKUP_MAX_BYTES) return undefined;
  const out = await gitOrNull(workDir, ['hash-object', '-w', '--no-filters', '--', t.abs], { write: true, timeoutMs: 30_000 });
  const id = out?.trim();
  return id && /^[0-9a-f]{40,64}$/.test(id) ? id : undefined;
}

/** Remove one file or one symbolic link. Never a folder, and never the target of a link. */
async function unlinkOne(abs: string): Promise<void> {
  const st = await lstatOrNull(abs);
  if (!st) return;
  if (!st.isFile() && !st.isSymbolicLink()) throw new Error('It is not a file. Dispatch removes single files only.');
  await fs.promises.unlink(abs);
}

async function discardOne(workDir: string, t: Target): Promise<void> {
  const c = t.change;
  // The place is checked again right before git acts on it: the first check was before the first file of the call.
  const restore = async (p: string, abs: string) => {
    await checkPlace(abs, p);
    return git(workDir, ['restore', '--source=HEAD', '--staged', '--worktree', '--', p], { write: true });
  };
  const unstageNew = (p: string) => git(workDir, ['rm', '--cached', '--force', '--quiet', '--', p], { write: true });
  if (c.status === 'untracked') return unlinkOne(t.abs);
  if (c.status === 'added') { await unstageNew(c.path); return unlinkOne(t.abs); }
  if (c.status === 'renamed' && c.oldPath) {
    // First bring the old file back, then take the new one away: a failure in between loses nothing.
    if (!t.oldAbs) throw new Error('The old path of the rename was not checked.');
    await restore(c.oldPath, t.oldAbs);
    await unstageNew(c.path);
    return unlinkOne(t.abs);
  }
  await restore(c.path, t.abs); // modified, deleted
}

/**
 * Discard the changes of the listed files: a tracked file goes back to its content in HEAD, a new file is removed.
 * Files that are not listed keep their changes.
 */
export async function discardPaths(workDir: string, paths: unknown, roots?: SecretRoots): Promise<DiscardResult> {
  const targets = await targetsOf(workDir, paths, roots);
  const result: DiscardResult = { discarded: [], errors: [] };
  for (const t of targets) {
    try {
      const copy = await backup(workDir, t);
      await discardOne(workDir, t);
      result.discarded.push({ path: t.change.path, ...(copy ? { backup: copy } : {}) });
    } catch (e) {
      result.errors.push({ path: t.change.path, error: busy(e).message });
      break;
    }
  }
  return result;
}
