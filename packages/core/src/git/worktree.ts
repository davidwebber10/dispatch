/**
 * A git worktree for one thread (engineering program W3-G).
 *
 * `createThreadWorktree` runs `git worktree add <project>/.claude/worktrees/<slug> -b dispatch/<slug> <HEAD commit>`.
 * That command does not change the project's branch, index or files. The new folder is inside the project, so it is
 * added to `.git/info/exclude` (git's own, untracked ignore file): `git status` in the project stays as it was and no
 * tracked file (`.gitignore`) is edited.
 *
 * `removeThreadWorktree` removes a worktree only when it holds no uncommitted work and no live thread uses it. It runs
 * `git worktree remove` with no `--force`, so git checks once more. The branch is never deleted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { git, gitOrNull, GitFailed } from './exec.js';
import { realDir } from './paths.js';
import { within } from '../files/confine.js';

export type WorktreeErrorCode = 'not_a_repo' | 'no_commit' | 'not_a_worktree' | 'dirty' | 'in_use' | 'failed';

export class WorktreeError extends Error {
  constructor(message: string, readonly code: WorktreeErrorCode) { super(message); this.name = 'WorktreeError'; }
}

export interface ThreadWorktree { path: string; branch: string }
export interface ThreadWorktreeState extends ThreadWorktree { dirty: boolean; inUse: boolean }

export const WORKTREES_DIR = path.join('.claude', 'worktrees');
export const BRANCH_PREFIX = 'dispatch/';
const EXCLUDE_LINE = '/.claude/worktrees/';

/** A folder and branch name from free text: lower case letters, digits and `-`, at most 40 characters. */
export function slugify(name: string | undefined): string {
  const s = String(name ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return s || 'thread';
}

async function requireRepo(projectDir: string): Promise<void> {
  const inside = (await gitOrNull(projectDir, ['rev-parse', '--is-inside-work-tree']))?.trim();
  if (inside !== 'true') throw new WorktreeError('This project folder is not a git repository. A worktree needs one.', 'not_a_repo');
}

/** Hide the worktrees folder from `git status` of the project, through git's own untracked ignore file. */
async function excludeWorktreesDir(projectDir: string, root: string): Promise<void> {
  // Already ignored (the project's .gitignore names it, like this repository's does): nothing to write.
  try { await git(projectDir, ['check-ignore', '--quiet', '--no-index', '--', path.join(root, 'probe')], { plainPathspecs: true }); return; } catch (e) {
    if (!(e instanceof GitFailed) || e.exitCode !== 1) return; // an error from git: leave its files alone
  }
  // The line is anchored at the repository root, so it is right only when the project folder is that root.
  const top = (await gitOrNull(projectDir, ['rev-parse', '--show-toplevel']))?.trim();
  if (!top || realDir(top) !== realDir(projectDir)) return;
  const common = (await gitOrNull(projectDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']))?.trim();
  if (!common) return;
  try {
    const file = path.join(common, 'info', 'exclude');
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    let cur = '';
    try { cur = await fs.promises.readFile(file, 'utf8'); } catch { /* no file yet */ }
    if (cur.split('\n').some((l) => l.trim() === EXCLUDE_LINE)) return;
    await fs.promises.writeFile(file, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${EXCLUDE_LINE}\n`);
  } catch { /* best effort: the worktree still works, the folder only shows as untracked */ }
}

/**
 * Make a worktree for a thread on a new branch `dispatch/<slug>` from the commit that HEAD names now.
 * `path` is where the thread runs: the same folder inside the worktree when the project is a folder of a larger repository.
 */
export async function createThreadWorktree(projectDir: string, opts: { name?: string } = {}): Promise<ThreadWorktree> {
  await requireRepo(projectDir);
  const head = (await gitOrNull(projectDir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']))?.trim();
  if (!head || !/^[0-9a-f]{40,64}$/.test(head)) throw new WorktreeError('This repository has no commit yet. Make the first commit, then start a thread in a worktree.', 'no_commit');
  const root = path.join(realDir(projectDir), WORKTREES_DIR);
  const base = slugify(opts.name);
  let slug = base;
  for (let n = 2; ; n++) {
    const taken = fs.existsSync(path.join(root, slug))
      || (await gitOrNull(projectDir, ['show-ref', '--verify', '--quiet', `refs/heads/${BRANCH_PREFIX}${slug}`])) !== null;
    if (!taken) break;
    if (n > 500) throw new WorktreeError('Could not find a free worktree name.', 'failed');
    slug = `${base}-${n}`;
  }
  const dir = path.join(root, slug);
  const branch = `${BRANCH_PREFIX}${slug}`;
  if (path.dirname(dir) !== root || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new WorktreeError('Bad worktree name.', 'failed');
  await excludeWorktreesDir(projectDir, root);
  try {
    await git(projectDir, ['worktree', 'add', '--quiet', '-b', branch, '--', dir, head], { write: true, timeoutMs: 120_000 });
  } catch (e) {
    throw new WorktreeError(`git could not make the worktree: ${(e as Error).message}`, 'failed');
  }
  // A project that is a folder of a larger repository: the thread runs in the same folder of the new worktree.
  const prefix = (await gitOrNull(projectDir, ['rev-parse', '--show-prefix']))?.trim().replace(/\/+$/, '') ?? '';
  const inner = prefix ? path.join(dir, ...prefix.split('/')) : dir;
  return { path: prefix && fs.existsSync(inner) ? inner : dir, branch };
}

/** Parse `git worktree list --porcelain -z`. */
async function gitWorktrees(projectDir: string): Promise<Array<{ path: string; branch: string | null }>> {
  const out = await gitOrNull(projectDir, ['worktree', 'list', '--porcelain', '-z']);
  if (out === null) return [];
  const res: Array<{ path: string; branch: string | null }> = [];
  for (const block of out.split('\0\0')) {
    const fields = block.split('\0').filter(Boolean);
    const wt = fields.find((f) => f.startsWith('worktree '));
    if (!wt) continue;
    const br = fields.find((f) => f.startsWith('branch '));
    res.push({ path: wt.slice('worktree '.length), branch: br ? br.slice('branch '.length).replace(/^refs\/heads\//, '') : null });
  }
  return res;
}

async function hasUncommittedWork(dir: string): Promise<boolean> {
  // Tracked changes (staged or not) and untracked files that no ignore rule covers. A failure reads as "has work".
  const out = await gitOrNull(dir, ['status', '--porcelain', '--untracked-files=normal']);
  return out === null || out.trim() !== '';
}

const usedBy = (dir: string, liveDirs: string[] | undefined): boolean => (liveDirs ?? []).some((d) => within(dir, realDir(d)));

/** The worktrees that Dispatch made for this project (the ones in `<project>/.claude/worktrees`). */
export async function listThreadWorktrees(projectDir: string, opts: { liveDirs?: string[] } = {}): Promise<ThreadWorktreeState[]> {
  const root = path.join(realDir(projectDir), WORKTREES_DIR);
  const res: ThreadWorktreeState[] = [];
  for (const wt of await gitWorktrees(projectDir)) {
    const real = realDir(wt.path);
    if (path.dirname(real) !== root || !wt.branch || !fs.existsSync(real)) continue;
    res.push({ path: real, branch: wt.branch, dirty: await hasUncommittedWork(real), inUse: usedBy(real, opts.liveDirs) });
  }
  return res.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * Remove one worktree of the project. Refused (`WorktreeError`) unless the path is a worktree that git lists in
 * `<project>/.claude/worktrees`, no live thread runs in it, and it holds no uncommitted work. The branch stays.
 */
export async function removeThreadWorktree(projectDir: string, worktreePath: string, opts: { liveDirs?: string[] } = {}): Promise<{ removed: true; path: string; branch: string }> {
  if (typeof worktreePath !== 'string' || !path.isAbsolute(worktreePath)) throw new WorktreeError('Give the full path of the worktree.', 'not_a_worktree');
  const real = realDir(worktreePath);
  const wt = (await listThreadWorktrees(projectDir, opts)).find((w) => w.path === real);
  if (!wt) throw new WorktreeError('This path is not a worktree that Dispatch made for this project.', 'not_a_worktree');
  if (wt.inUse) throw new WorktreeError('A thread still runs in this worktree. Archive the thread first.', 'in_use');
  if (wt.dirty) throw new WorktreeError('This worktree has uncommitted changes. Dispatch does not remove it. Commit or discard the changes first.', 'dirty');
  try {
    await git(projectDir, ['worktree', 'remove', '--', wt.path], { write: true, timeoutMs: 60_000 });
  } catch (e) {
    const msg = (e as Error).message;
    throw new WorktreeError(`git did not remove the worktree: ${msg}`, /modified or untracked|is dirty|contains modified/i.test(msg) ? 'dirty' : 'failed');
  }
  return { removed: true, path: wt.path, branch: wt.branch };
}
