import { Router } from 'express';
import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';
import type { EventBroadcaster } from '../ws/events.js';
import { applyUpdate, preflightUpdate, type GitExec } from '../update/apply.js';
import { checkForUpdateOnce } from '../update/checker.js';
import { getRunningVersion, isNewerVersion } from '../update/version.js';
import {
  applyHostedUpdate,
  checkHostedUpdate,
  hostedTarget,
  type HostedTarget,
} from '../update/hosted.js';

export interface CreateUpdateRouterOptions {
  /** Test seam: inject a fake git runner instead of shelling out to real git. */
  gitExec?: GitExec;
  /** Test seam: replace the real detached-spawn of `bin/dispatch update`. */
  applyFn?: (repoDir: string) => void;
  /** Test seam: replace the real GitHub release poll. */
  checkFn?: (db: Database.Database, broadcaster: EventBroadcaster) => Promise<void>;
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
}

export function createUpdateRouter(broadcaster: EventBroadcaster, repoDir: string, db: Database.Database, opts?: CreateUpdateRouterOptions): Router {
  const router = Router();
  const apply = opts?.applyFn ?? applyUpdate;
  const check = opts?.checkFn ?? checkForUpdateOnce;
  // Resolved once at construction: a box does not become un-hosted at runtime.
  const hosted = opts?.hosted !== undefined ? opts.hosted : hostedTarget();
  const hostedApply = opts?.hostedApplyFn ?? applyHostedUpdate;
  const hostedCheck = opts?.hostedCheckFn ?? checkHostedUpdate;

  // POST /api/update/check — poll GitHub for the latest release right now (the
  // background loop only fires every ~45 min) and answer with the same shape as
  // GET /api/state/update so the Settings "Check for updates" button is one call.
  router.post('/check', async (_req, res) => {
    // A hosted box updates by rolling onto a newer IMAGE, so the question is
    // "what has been built?", not "what has been released on GitHub" — a release
    // that nobody has built into an image is not an update this box can take.
    if (hosted) {
      const state = await hostedCheck(hosted, getRunningVersion());
      res.json({ ...state, url: null, publishedAt: null, hosted: true });
      return;
    }
    await check(db, broadcaster);
    const tag = appState.get(db, 'latest_release_tag');
    const currentVersion = getRunningVersion();
    const available = !!tag && isNewerVersion(tag, currentVersion);
    res.json({
      available,
      version: available ? tag : null,
      url: available ? appState.get(db, 'latest_release_url') : null,
      publishedAt: available ? appState.get(db, 'latest_release_published_at') : null,
      currentVersion,
    });
  });

  // POST /api/update/apply — preflight (clean tree + fast-forwardable), then spawn
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
      // Same event the git path emits, so the client shows the same progress UI.
      // The rollover ends with this process being replaced; the client sees the
      // socket drop and reconnects to the new task.
      broadcaster.broadcast({ type: 'update:in-progress' });
      res.json({ ok: true, hosted: true });
      return;
    }

    const force = req.body?.force === true;
    const result = preflightUpdate(repoDir, opts?.gitExec, { force });
    if (!result.ok) {
      res.status(409).json({
        ok: false,
        reason: result.reason,
        dirty: result.dirty,
        dirtyOverflow: result.dirtyOverflow,
        forceable: result.forceable,
      });
      return;
    }
    broadcaster.broadcast({ type: 'update:in-progress' });
    apply(repoDir);
    res.json({ ok: true });
  });

  return router;
}
