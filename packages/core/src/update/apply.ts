import { execFileSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { platform } from '../platform/index.js';
import { markUpdateFailed } from './progress.js';
import { getRunningVersion } from './version.js';
import {
  MoveRefused, planMove, ReleaseSourceError, resolveTarget, stepFailed,
  type FetchReleasesOptions, type GitExec, type Move,
} from './target.js';

export type { GitExec };

/** Runs git against `repoDir` (this file is the update's one place that spawns git; see tests/privsep/spawn-sites.test.ts). */
export function makeGitExec(repoDir: string): GitExec {
  return (args) => execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf-8' });
}

export interface PreflightResult {
  ok: boolean;
  reason?: string;
  /** Parsed `git status --porcelain` rows, set only on a dirty-tree failure. */
  dirty?: { status: string; path: string }[];
  /** How many dirty rows were omitted past the 50-entry cap. */
  dirtyOverflow?: number;
  /** True when the dirty tree is the ONLY blocker — i.e. `force: true` would proceed. */
  forceable?: boolean;
  /** On `ok`: how the checkout gets to the release (`back` needs the explicit switch, already given). */
  move?: Move;
  /** True when the only thing missing is the explicit switch back (the checkout is ahead of the newest release). */
  needsSwitchBack?: boolean;
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

export interface PreflightOptions extends FetchReleasesOptions {
  /** Skip ONLY the dirty-tree gate, for a forward update. Never lifts the clean-tree need of a move back. */
  force?: boolean;
  /** The person explicitly chose to move back to the newest release (the Switch button). */
  switchBack?: boolean;
  /** The version this checkout runs. Defaults to the running daemon's. */
  version?: string;
}

/**
 * Confirms it is safe to run `bin/dispatch update`: it asks the shared rule (update/target.ts) for the
 * target (the newest published release on main), then how this checkout gets there. Injectable `gitExec`
 * lets tests simulate dirty trees and diverged branches without touching real git.
 *
 * `opts.force` skips ONLY the dirty-tree gate of a forward update. Fetch, target and move checks always
 * run and can still refuse (a diverged branch is never forceable). A move back is never forced and
 * needs `opts.switchBack`; without it the answer carries `needsSwitchBack`.
 */
export async function preflightUpdate(repoDir: string, gitExec?: GitExec, opts: PreflightOptions = {}): Promise<PreflightResult> {
  const git = gitExec ?? makeGitExec(repoDir);

  let status: string;
  try {
    status = git(['status', '--porcelain']);
  } catch (err: any) {
    return { ok: false, reason: stepFailed('git status failed', err) };
  }
  if (status.trim().length > 0 && !opts.force) {
    const { entries, overflow } = parsePorcelain(status);
    return {
      ok: false,
      reason: 'Working tree has uncommitted changes — commit or stash before updating, or update anyway to let git decide (it refuses only if the update touches a file you changed).',
      dirty: entries,
      dirtyOverflow: overflow,
      forceable: true,
    };
  }

  let move: Move;
  try {
    const target = await resolveTarget(git, opts);
    move = planMove(git, target, { version: opts.version ?? getRunningVersion(), allowBack: opts.switchBack === true });
  } catch (err: unknown) {
    if (err instanceof MoveRefused) return { ok: false, reason: err.message, ...(err.needsSwitchBack ? { needsSwitchBack: true } : {}) };
    if (err instanceof ReleaseSourceError) return { ok: false, reason: err.message };
    return { ok: false, reason: stepFailed('could not work out the release to install', err) };
  }
  return { ok: true, move };
}

/** Keep build diagnostics, and notify clients if the detached updater fails before restart. */
export function applyUpdate(repoDir: string, onFailure?: (reason: string) => void, opts?: { switchBack?: boolean }): void {
  const logDir = platform.logDir();
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'update.log');
  const log = fs.openSync(logPath, 'a', 0o600);
  // `detail` (a system error's text names folders) goes to the log file only; the status file and the
  // broadcast, which every connected client sees, get the plain reason.
  const fail = (reason: string, detail?: string) => {
    fs.appendFileSync(logPath, `[dispatch] ${reason}${detail ? ` ${detail}` : ''}\n`);
    // The update window reads the status file; keep a step error the updater already wrote.
    markUpdateFailed(platform.dataDir(), reason);
    onFailure?.(`${reason} See update.log in the Dispatch logs folder for details.`);
  };
  try {
    fs.writeSync(log, `\n[dispatch] Update started ${new Date().toISOString()}\n`);
    const child = spawn(path.join(repoDir, 'bin', 'dispatch'), ['update', ...(opts?.switchBack ? ['--switch-back'] : [])], {
      cwd: repoDir,
      detached: true,
      stdio: ['ignore', log, log],
    });
    child.once('error', error => fail('Could not start updater.', error.message));
    child.once('exit', (code, signal) => {
      if (code !== 0) fail(`Update failed (${signal ?? `exit ${code}`}).`);
    });
    child.unref();
  } finally { fs.closeSync(log); }
}
