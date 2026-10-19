/**
 * Read-only git helpers for the doc resolver (chat thread visibility spec, 12.5).
 *
 * - Every call is `execFileSync('git', ['-C', dir, ...])`: no shell, a 5 s timeout, stderr dropped.
 * - The `ref` given to `blobHash`, `blobSize`, `readBlob` and `commitDate` must always be a name
 *   from `refs()` (or `defaultBranch()`), so no user input reaches git as an option.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const GIT_TIMEOUT_MS = 5000;

/** Stdout as bytes, or null on any error (not a repo, a bad ref, a timeout). */
export function gitBuffer(dir: string, args: string[]): Buffer | null {
  try { return execFileSync('git', ['-C', dir, ...args], { timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 }); } catch { return null; }
}
export function git(dir: string, args: string[]): string | null { const b = gitBuffer(dir, args); return b ? b.toString('utf8') : null; }

/**
 * True when `dir` is the top folder of a git work tree. A folder inside a bigger repository is
 * not a repo here: its tree paths would be relative to that repository's root, which is outside
 * the project folder.
 */
export function isRepo(dir: string): boolean {
  const top = git(dir, ['rev-parse', '--show-toplevel'])?.trim();
  if (!top) return false;
  try { return fs.realpathSync(top) === fs.realpathSync(dir); } catch { return false; }
}

/** Linked worktrees (`git worktree list --porcelain`, the main checkout left out); branch without refs/heads/. */
export function worktrees(dir: string): { path: string; branch: string | null }[] {
  const out = git(dir, ['worktree', 'list', '--porcelain']);
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

/** Local and remote branches, no `origin/HEAD`; date = committer unix seconds. */
export function refs(dir: string): { name: string; date: number }[] {
  const out = git(dir, ['for-each-ref', '--format=%(refname:short)%09%(committerdate:unix)', 'refs/heads', 'refs/remotes']);
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((l) => { const [name, d] = l.split('\t'); return { name, date: Number(d) || 0 }; }).filter((r) => !r.name.endsWith('/HEAD') && r.name !== 'origin');
}

/** The origin/HEAD target, else main, else master. */
export function defaultBranch(dir: string): string | null {
  const head = git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])?.trim();
  if (head) return head;
  const names = new Set(refs(dir).map((r) => r.name));
  return names.has('main') ? 'main' : names.has('master') ? 'master' : null;
}

const spec = (ref: string, rel: string) => `${ref}:${rel.split('\\').join('/')}`;
export const blobHash = (dir: string, ref: string, rel: string) => git(dir, ['rev-parse', '--verify', '--quiet', spec(ref, rel)])?.trim() || null;
export function blobSize(dir: string, ref: string, rel: string): number | null { const s = git(dir, ['cat-file', '-s', spec(ref, rel)]); return s ? Number(s.trim()) : null; }
export const readBlob = (dir: string, ref: string, rel: string) => gitBuffer(dir, ['cat-file', 'blob', spec(ref, rel)]);
/** The git blob sha1 of `buf` (what `git hash-object` prints). */
export function hashBytes(buf: Buffer): string { return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex'); }
/** The ISO committer date of the last commit on `ref` that touched `rel`. */
export const commitDate = (dir: string, ref: string, rel: string) => git(dir, ['log', '-1', '--format=%cI', ref, '--', rel])?.trim() || null;
