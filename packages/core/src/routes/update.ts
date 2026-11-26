import type { Router } from 'express';
import { policyRouter } from '../auth/route-policy.js';
import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';
import type { EventBroadcaster } from '../ws/events.js';
import { applyUpdate, preflightUpdate, type GitExec } from '../update/apply.js';
import { checkForUpdateOnce } from '../update/checker.js';
import { getReportedVersion, getRunningVersion } from '../update/version.js';
import { storedUpdateView } from '../update/stored.js';
import { markUpdateStarted, markHostedUpdateStarted, readUpdateProgress } from '../update/progress.js';
import { platform } from '../platform/index.js';
import path from 'path';
import {
  applyHostedUpdate,
  checkHostedUpdate,
  resetHostedUpdateCache,
  hostedTarget,
  type HostedTarget,
} from '../update/hosted.js';

export interface CreateUpdateRouterOptions {
  /** Test seam: inject a fake git runner instead of shelling out to real git. */
  gitExec?: GitExec;
  /** Test seam: replace the real detached-spawn of `bin/dispatch update`. */
  applyFn?: (repoDir: string, opts?: { switchBack?: boolean }) => void;
  /** Test seam: replace the GitHub release list the apply preflight asks (the shared rule in update/target.ts). */
  releasesFetch?: typeof fetch;
  /** Test seam: replace the real GitHub release poll. */
  checkFn?: (db: Database.Database, broadcaster: EventBroadcaster) => Promise<void>;
  /** Test seam: how long apply/check wait on GitHub (default CHECK_WAIT_MS). */
  checkWaitMs?: number;
  /**
   * Test seam / override: the OS control plane to ask on a hosted box. Defaults
   * to reading the environment, where `null` means "ordinary local daemon" and
   * the git path below runs unchanged.
   */
  hosted?: HostedTarget | null;
  /** Test seam: replace the hosted rebuild request. */
  hostedApplyFn?: typeof applyHostedUpdate;
  /** Test seam: replace the hosted availability check. */
  hostedCheckFn?: typeof checkHostedUpdate;
  /** Where the updater writes update-status.json (default: platform.dataDir()). */
  dataDir?: string;
  /** The updater's output (default: <platform.logDir()>/update.log). */
  updateLogPath?: string;
}

/** A check younger than this is fresh enough to show. */
export const FRESH_MS = 60_000;
/** The longest a request waits on GitHub before going on with what is stored. */
export const CHECK_WAIT_MS = 6_000;

export function createUpdateRouter(broadcaster: EventBroadcaster, repoDir: string, db: Database.Database, opts?: CreateUpdateRouterOptions): Router {
  const router = policyRouter();
  const apply = opts?.applyFn ?? ((dir: string, o?: { switchBack?: boolean }) => applyUpdate(dir, reason => broadcaster.broadcast({ type: 'update:failed', reason }), o));
  const check = opts?.checkFn ?? ((d: Database.Database, b: EventBroadcaster) => checkForUpdateOnce(d, b, { repoDir, git: opts?.gitExec, fetchImpl: opts?.releasesFetch }));
  // Resolved once at construction: a box does not become un-hosted at runtime.
  const hosted = opts?.hosted !== undefined ? opts.hosted : hostedTarget();
  const hostedApply = opts?.hostedApplyFn ?? applyHostedUpdate;
  const hostedCheck = opts?.hostedCheckFn ?? checkHostedUpdate;
  const dataDir = opts?.dataDir ?? platform.dataDir();
  const updateLogPath = opts?.updateLogPath ?? path.join(platform.logDir(), 'update.log');

  /**
   * Ask GitHub again unless it was asked in the last FRESH_MS, waiting at most CHECK_WAIT_MS
   * (2026-11-05). The stored release is what Settings and the update prompt show, but the update
   * itself goes to the newest tag on origin. When a second release came out after the last check,
   * the screen showed the older version's notes while the newer one was installed.
   * The window spares GitHub's unauthenticated limit (60 calls an hour) when Settings is reopened.
   */
  const freshCheck = async () => {
    const last = Date.parse(appState.get(db, 'last_checked_ts') ?? '');
    if (Number.isFinite(last) && Date.now() - last < FRESH_MS) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      check(db, broadcaster).catch(() => {}),
      new Promise<void>((r) => { timer = setTimeout(r, opts?.checkWaitMs ?? CHECK_WAIT_MS); }),
    ]);
    clearTimeout(timer);
  };

  // GET /api/update/progress — the running (or last) update's step, error and output tail,
  // from the updater's status file (update/progress.ts). The update window polls it.
  router.get('/progress', (_req, res) => {
    res.json(readUpdateProgress({ dataDir, logPath: updateLogPath, hosted: !!hosted }));
  });

  // POST /api/update/check — poll GitHub for the latest release right now (the
  // background loop only fires every ~45 min) and answer with the same shape as
  // GET /api/state/update so the Settings "Check for updates" button is one call.
  router.post('/check', async (_req, res) => {
    // A hosted box updates by rolling onto a newer IMAGE, so the question is
    // "what has been built?", not "what has been released on GitHub" — a release
    // that nobody has built into an image is not an update this box can take.
    if (hosted) {
      const state = await hostedCheck(hosted, getReportedVersion());
      resetHostedUpdateCache({ version: getReportedVersion(), state }); // GET /api/state/update agrees at once
      res.json({ ...state, url: null, publishedAt: null, hosted: true });
      return;
    }
    await freshCheck();
    const currentVersion = getRunningVersion();
    res.json({ ...storedUpdateView(db, currentVersion), currentVersion });
  });

  // POST /api/update/apply — preflight (clean tree, a release to move to, and a safe move), then spawn
  // `bin/dispatch update` detached and let the daemon's existing safe-restart path
  // (launchctl kickstart -k) take it from there.
  router.post('/apply', async (req, res) => {
    // The hosted path deliberately skips the git preflight. There is no checkout
    // to be dirty and no branch to fast-forward; running it produced exactly the
    // "git status failed: not a git repository" a box reports today, which reads
    // as a broken button rather than as "this deployment updates differently".
    if (hosted) {
      const out = await hostedApply(hosted);
      if (!out.ok) {
        res.status(409).json({ ok: false, reason: out.reason, hosted: true });
        return;
      }
      markHostedUpdateStarted(dataDir); // one step, "Move your workspace to the new version"
      // Same event the git path emits, so the client shows the same progress UI.
      // The rollover ends with this process being replaced; the client sees the
      // socket drop and reconnects to the new task.
      broadcaster.broadcast({ type: 'update:in-progress' });
      res.json({ ok: true, hosted: true });
      return;
    }

    const force = req.body?.force === true;
    // The explicit switch back: only a body that says so lets the update move a copy that runs a version
    // newer than the newest release. Never inferred from the state, so no client moves back by accident.
    const switchBack = req.body?.switchBack === true;
    const result = await preflightUpdate(repoDir, opts?.gitExec, { force, switchBack, fetchImpl: opts?.releasesFetch });
    if (!result.ok) {
      res.status(409).json({
        ok: false,
        reason: result.reason,
        dirty: result.dirty,
        dirtyOverflow: result.dirtyOverflow,
        forceable: result.forceable,
        ...(result.needsSwitchBack ? { needsSwitchBack: true } : {}),
      });
      return;
    }
    // Refresh the stored release first, so the version and notes on screen are the ones being
    // installed (the check broadcasts update:available, and every client reloads them).
    await freshCheck();
    markUpdateStarted(dataDir);
    broadcaster.broadcast({ type: 'update:in-progress' });
    // The updater gets the permission to move back only when the plan IS a move back.
    if (result.move === 'back') apply(repoDir, { switchBack: true });
    else apply(repoDir);
    res.json({ ok: true });
  });

  return router;
}
