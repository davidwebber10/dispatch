import { execFileSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { platform } from '../platform/index.js';
import { markUpdateFailed } from './progress.js';

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
 * The newest plain release tag (vX.Y.Z) in `git tag -l` output that is sorted newest first. Prerelease
 * and other tag shapes are ignored. Keep in step with the same function in packages/cli/src/index.ts.
 */
export function latestReleaseTag(tagList: string): string | null {
  return tagList.split('\n').map((t) => t.trim()).find((t) => /^v\d+\.\d+\.\d+$/.test(t)) ?? null;
}

/**
 * Confirms it's safe to run `bin/dispatch update` (which fast-forwards to the newest release tag):
 * a clean working tree and a checkout that can fast-forward to that tag. Injectable
 * `gitExec` lets tests simulate dirty trees / diverged branches without touching real git.
 *
 * `opts.force` skips ONLY the dirty-tree gate below — fetch, branch resolution, and
 * the tag and fast-forward/ancestor checks always run and can still fail the preflight (a
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
    // Tags are what a release is: update follows the newest one, not the tip of main.
    // No --force: a tag that moved upstream is refused, not silently followed.
    git(['fetch', 'origin', '--tags']);
  } catch (err: any) {
    return { ok: false, reason: `git fetch failed: ${err.message}` };
  }

  let tag: string | null;
  try {
    tag = latestReleaseTag(git(['tag', '-l', 'v*', '--sort=-v:refname']));
  } catch (err: any) {
    return { ok: false, reason: `could not list release tags: ${err.message}` };
  }
  if (!tag) {
    return { ok: false, reason: 'No release tag (vX.Y.Z) was found on origin, so there is nothing to update to.' };
  }

  let localHead: string;
  let tagHead: string;
  try {
    localHead = git(['rev-parse', 'HEAD']).trim();
    tagHead = git(['rev-parse', `${tag}^{commit}`]).trim();
  } catch (err: any) {
    return { ok: false, reason: `could not resolve ${tag}: ${err.message}` };
  }

  // Either way round is fine: HEAD behind the tag fast-forwards to it, and HEAD already containing
  // the tag (a checkout that is ahead of the newest release) has nothing to take.
  const isAncestor = (a: string, b: string): boolean => {
    try { git(['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; }
  };
  if (!isAncestor(localHead, tagHead) && !isAncestor(tagHead, localHead)) {
    return { ok: false, reason: `This checkout has diverged from release ${tag} — cannot fast-forward. Run 'dispatch update' manually after resolving.` };
  }

  return { ok: true };
}

/** Keep build diagnostics, and notify clients if the detached updater fails before restart. */
export function applyUpdate(repoDir: string, onFailure?: (reason: string) => void): void {
  const logDir = platform.logDir();
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'update.log');
  const log = fs.openSync(logPath, 'a', 0o600);
  const fail = (reason: string) => {
    fs.appendFileSync(logPath, `[dispatch] ${reason}\n`);
    // The update window reads the status file; keep a step error the updater already wrote.
    markUpdateFailed(platform.dataDir(), reason);
    onFailure?.(`${reason} See ${logPath} for details.`);
  };
  try {
    fs.writeSync(log, `\n[dispatch] Update started ${new Date().toISOString()}\n`);
    const child = spawn(path.join(repoDir, 'bin', 'dispatch'), ['update'], {
      cwd: repoDir,
      detached: true,
      stdio: ['ignore', log, log],
    });
    child.once('error', error => fail(`Could not start updater: ${error.message}`));
    child.once('exit', (code, signal) => {
      if (code !== 0) fail(`Update failed (${signal ?? `exit ${code}`}).`);
    });
    child.unref();
  } finally { fs.closeSync(log); }
}
