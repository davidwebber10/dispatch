import { execFileSync, spawn } from 'child_process';
import path from 'path';

export interface PreflightResult {
  ok: boolean;
  reason?: string;
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
 */
export function preflightUpdate(repoDir: string, gitExec?: GitExec): PreflightResult {
  const git = gitExec ?? makeGitExec(repoDir);

  let status: string;
  try {
    status = git(['status', '--porcelain']);
  } catch (err: any) {
    return { ok: false, reason: `git status failed: ${err.message}` };
  }
  if (status.trim().length > 0) {
    return { ok: false, reason: 'Working tree has uncommitted changes — commit or stash before updating.' };
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

  let localHead: string;
  let remoteHead: string;
  try {
    localHead = git(['rev-parse', 'HEAD']).trim();
    remoteHead = git(['rev-parse', `origin/${branch}`]).trim();
  } catch (err: any) {
    return { ok: false, reason: `could not resolve origin/${branch}: ${err.message}` };
  }

  try {
    git(['merge-base', '--is-ancestor', localHead, remoteHead]);
  } catch {
    return { ok: false, reason: `Local ${branch} has diverged from origin/${branch} — cannot fast-forward. Run 'dispatch update' manually after resolving.` };
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
