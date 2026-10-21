/**
 * Read-only git helpers for the doc resolver (chat thread visibility spec, 12.5).
 *
 * - Every call is `git --no-optional-locks -C dir ...` through `execFileSync` or `execFile`: no
 *   shell, a 5 s timeout, stderr dropped. `--no-optional-locks` keeps a background `git status` or `diff` from
 *   taking the index lock, so an agent's own `git commit` in the same worktree never fails on it.
 *   The `...Async` twins use `execFile` (no shell either, the same timeout and output cap) so the
 *   docs list and the doc resolver never block the daemon's event loop. The sync ones stay only for
 *   the Overseer source panel (`projectWorktrees` in overseer/source-file.ts).
 * - The `ref` given to `blobHashAsync`, `blobSizeAsync`, `readBlobAsync` and `commitDateAsync` must
 *   always be a name from `refsAsync()` (or `defaultBranchAsync()`), so no user input reaches git as
 *   an option.
 */
import fs from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
/** The newest this many unmerged branches are searched (the docs list and the resolver). */
export const DOCS_BRANCHES = 20;

/** The full argument list for `git`: no optional lock, then the folder, then `args`. */
export function gitArgs(dir: string, args: string[]): string[] { return ['--no-optional-locks', '-C', dir, ...args]; }

/** Stdout as bytes, or null on any error (not a repo, a bad ref, a timeout). */
export function gitBuffer(dir: string, args: string[]): Buffer | null {
  try { return execFileSync('git', gitArgs(dir, args), { timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: GIT_MAX_BUFFER }); } catch { return null; }
}
export function git(dir: string, args: string[]): string | null { const b = gitBuffer(dir, args); return b ? b.toString('utf8') : null; }

function isTop(dir: string, out: string | null): boolean {
  const top = out?.trim();
  if (!top) return false;
  try { return fs.realpathSync.native(top) === fs.realpathSync.native(dir); } catch { return false; }
}

/** Linked worktrees (`git worktree list --porcelain`, the main checkout left out); branch without refs/heads/. */
export function worktrees(dir: string): { path: string; branch: string | null }[] {
  return parseWorktrees(git(dir, ['worktree', 'list', '--porcelain']));
}
function parseWorktrees(out: string | null): { path: string; branch: string | null }[] {
  if (!out) return [];
  const list: { path: string; branch: string | null }[] = [];
  for (const block of out.split('\n\n')) {
    const p = /^worktree (.+)$/m.exec(block)?.[1];
    if (!p) continue;
    const b = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null;
    list.push({ path: p, branch: b });
  }
  return list.slice(1); // the first entry is the main checkout
}

const REFS_ARGS = ['for-each-ref', '--format=%(refname:short)%09%(committerdate:unix)', 'refs/heads', 'refs/remotes'];
function parseRefs(out: string | null): { name: string; date: number }[] {
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((l) => { const [name, d] = l.split('\t'); return { name, date: Number(d) || 0 }; }).filter((r) => !r.name.endsWith('/HEAD') && r.name !== 'origin' && !r.name.startsWith('-'));
}

const ORIGIN_HEAD_ARGS = ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'];
function pickDefault(headOut: string | null, list: { name: string }[]): string | null {
  const head = headOut?.trim();
  const names = new Set(list.map((r) => r.name));
  if (head && names.has(head)) return head;
  return names.has('main') ? 'main' : names.has('master') ? 'master' : null;
}

const spec = (ref: string, rel: string) => `${ref}:${rel.split('\\').join('/')}`;
/** The git blob sha1 of `buf` (what `git hash-object` prints). */
export function hashBytes(buf: Buffer): string { return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex'); }

// Async helpers (the docs list and the doc resolver). Same arguments and rules as the sync ones above.

/** Stdout as bytes, or null on any error (not a repo, a bad ref, a timeout, output over the cap). */
export function gitBufferAsync(dir: string, args: string[]): Promise<Buffer | null> {
  return new Promise((resolve) => {
    try {
      const child = execFile('git', gitArgs(dir, args), { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: 'buffer' }, (err, stdout) => resolve(err ? null : stdout));
      child.stdin?.end();
    } catch { resolve(null); }
  });
}
export async function gitAsync(dir: string, args: string[]): Promise<string | null> { const b = await gitBufferAsync(dir, args); return b ? b.toString('utf8') : null; }
/**
 * True when `dir` is the top folder of a git work tree. A folder inside a bigger repository is
 * not a repo here: its tree paths would be relative to that repository's root, which is outside
 * the project folder.
 */
export async function isRepoAsync(dir: string): Promise<boolean> { return isTop(dir, await gitAsync(dir, ['rev-parse', '--show-toplevel'])); }
export async function worktreesAsync(dir: string): Promise<{ path: string; branch: string | null }[]> { return parseWorktrees(await gitAsync(dir, ['worktree', 'list', '--porcelain'])); }
/** Local and remote branches, no `origin/HEAD`, no name that starts with "-"; date = committer unix seconds. */
export async function refsAsync(dir: string): Promise<{ name: string; date: number }[]> { return parseRefs(await gitAsync(dir, REFS_ARGS)); }
/** The origin/HEAD target (only when `refsAsync()` lists it), else main, else master. `known`: a `refsAsync(dir)` the caller already has. */
export async function defaultBranchAsync(dir: string, known?: { name: string }[]): Promise<string | null> {
  const [head, list] = await Promise.all([gitAsync(dir, ORIGIN_HEAD_ARGS), known ?? refsAsync(dir)]);
  return pickDefault(head, list);
}
/** The branch `dir` has checked out, or null (a detached HEAD, not a repo, an error). */
export async function currentBranchAsync(dir: string): Promise<string | null> { return (await gitAsync(dir, ['symbolic-ref', '--short', '-q', 'HEAD']))?.trim() || null; }
/** The names of the git remotes of `dir` (empty on any error). */
export async function remotesAsync(dir: string): Promise<string[]> { return ((await gitAsync(dir, ['remote'])) ?? '').split('\n').map((s) => s.trim()).filter(Boolean); }
export const blobHashAsync = async (dir: string, ref: string, rel: string) => (await gitAsync(dir, ['rev-parse', '--verify', '--quiet', spec(ref, rel)]))?.trim() || null;
export async function blobSizeAsync(dir: string, ref: string, rel: string): Promise<number | null> { const s = await gitAsync(dir, ['cat-file', '-s', spec(ref, rel)]); return s ? Number(s.trim()) : null; }
export const readBlobAsync = (dir: string, ref: string, rel: string) => gitBufferAsync(dir, ['cat-file', 'blob', spec(ref, rel)]);
/** The ISO committer date of the last commit on `ref` that touched `rel`. */
export const commitDateAsync = async (dir: string, ref: string, rel: string) => (await gitAsync(dir, ['log', '-1', '--format=%cI', ref, '--', rel]))?.trim() || null;
