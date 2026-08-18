import { execFileSync, spawn } from 'child_process';
import path from 'path';

export interface PreflightResult {
  ok: boolean;
  reason?: string;
  /** Parsed `git status --porcelain` rows, set only on a dirty-tree failure. */
  dirty?: { status: string; path: string }[];
  /** How many dirty rows were omitted past the 50-entry cap. */
  dirtyOverflow?: number;
  /** True when the dirty tree is the ONLY blocker — i.e. `force: true` would proceed. */
  forceable?: boolean;
}

const MAX_DIRTY_ENTRIES = 50;

/**
 * Parses `git status --porcelain` output into `{ status, path }` rows. Each line is
 * `XY <path>`, where `XY` is the two-character status code (`??` untracked, ` M`
 * modified, `A ` added, etc.); rename/copy rows (`R  old -> new`) keep the full
 * `old -> new` remainder as the path. Capped at 50 entries; the rest are counted
 * as `overflow` so a pathological tree can't produce a giant response.
 */
export function parsePorcelain(status: string): { entries: { status: string; path: string }[]; overflow: number } {
  const rows = status.split('\n').filter((l) => l.trim().length > 0);
  const entries = rows.slice(0, MAX_DIRTY_ENTRIES).map((l) => ({ status: l.slice(0, 2), path: l.slice(3).trim() }));
  return { entries, overflow: Math.max(0, rows.length - MAX_DIRTY_ENTRIES) };
}

/** Runs a git subcommand against `repoDir` and returns stdout; throws on non-zero exit. */
export type GitExec = (args: string[]) => string;

export function makeGitExec(repoDir: string): GitExec {
  return (args) => execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf-8' });
}

/**
 * Confirms it's safe to run `bin/dispatch update` (which does `git pull --ff-only`):
 * a clean working tree and a local branch that can fast-forward to origin. Injectable
 * `gitExec` lets tests simulate dirty trees / diverged branches without touching real git.
 *
 * `opts.force` skips ONLY the dirty-tree gate below — fetch, branch resolution, and
 * the fast-forward/ancestor check always run and can still fail the preflight (a
 * diverged branch is never forceable; `git pull --ff-only` has the final say).
 */
export function preflightUpdate(repoDir: string, gitExec?: GitExec, opts?: { force?: boolean }): PreflightResult {
  const git = gitExec ?? makeGitExec(repoDir);

  let status: string;
  try {
    status = git(['status', '--porcelain']);
  } catch (err: any) {
    return { ok: false, reason: `git status failed: ${err.message}` };
  }
  if (status.trim().length > 0 && !opts?.force) {
    const { entries, overflow } = parsePorcelain(status);
    return {
      ok: false,
      reason: 'Working tree has uncommitted changes — commit or stash before updating, or update anyway to let git decide (it refuses only if the update touches a file you changed).',
      dirty: entries,
      dirtyOverflow: overflow,
      forceable: true,
    };
  }

  try {
    git(['fetch', 'origin']);
  } catch (err: any) {
    return { ok: false, reason: `git fetch failed: ${err.message}` };
  }

  let branch: string;
  try {
    branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  } catch (err: any) {
    return { ok: false, reason: `could not determine current branch: ${err.message}` };
  }

  // Resolve the branch's configured upstream (@{u}) rather than assuming origin/<branch> exists.
  // A checkout sitting on a local-only feature branch — never pushed, so there is no
  // origin/<branch> — has no upstream and cannot be fast-forwarded. Say so actionably instead of
  // failing on the cryptic `could not resolve origin/<branch>` a bare `rev-parse origin/<branch>`
  // produced. (The manual fallback `dispatch update` runs `git pull --ff-only`, which also fails
  // on such a branch — "no tracking information" — so pointing at it would be dead advice.)
  let upstream: string;
  try {
    upstream = git(['rev-parse', '--abbrev-ref', '@{u}']).trim();
  } catch {
    return {
      ok: false,
      reason: `This checkout is on '${branch}', which has no upstream branch to update from — the daemon only auto-updates a branch that tracks a remote (normally main). Switch to the release branch with \`git checkout main\` and update, or if you're developing on '${branch}', bring in the latest with \`git fetch origin && git merge origin/main\` and rebuild.`,
    };
  }

  let localHead: string;
  let remoteHead: string;
  try {
    localHead = git(['rev-parse', 'HEAD']).trim();
    remoteHead = git(['rev-parse', upstream]).trim();
  } catch (err: any) {
    return { ok: false, reason: `could not resolve ${upstream}: ${err.message}` };
  }

  try {
    git(['merge-base', '--is-ancestor', localHead, remoteHead]);
  } catch {
    return { ok: false, reason: `Local ${branch} has diverged from ${upstream} — cannot fast-forward. Run 'dispatch update' manually after resolving.` };
  }

  return { ok: true };
}

/** Spawns `bin/dispatch update` detached so it survives this request/process. */
export function applyUpdate(repoDir: string): void {
  const child = spawn(path.join(repoDir, 'bin', 'dispatch'), ['update'], {
    cwd: repoDir,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}
