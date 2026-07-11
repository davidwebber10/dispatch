import { Router } from 'express';
import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';
import type { EventBroadcaster } from '../ws/events.js';
import { applyUpdate, preflightUpdate, type GitExec } from '../update/apply.js';
import { checkForUpdateOnce } from '../update/checker.js';
import { getRunningVersion, isNewerVersion } from '../update/version.js';

export interface CreateUpdateRouterOptions {
  /** Test seam: inject a fake git runner instead of shelling out to real git. */
  gitExec?: GitExec;
  /** Test seam: replace the real detached-spawn of `bin/dispatch update`. */
  applyFn?: (repoDir: string) => void;
  /** Test seam: replace the real GitHub release poll. */
  checkFn?: (db: Database.Database, broadcaster: EventBroadcaster) => Promise<void>;
}

export function createUpdateRouter(broadcaster: EventBroadcaster, repoDir: string, db: Database.Database, opts?: CreateUpdateRouterOptions): Router {
  const router = Router();
  const apply = opts?.applyFn ?? applyUpdate;
  const check = opts?.checkFn ?? checkForUpdateOnce;

  // POST /api/update/check — poll GitHub for the latest release right now (the
  // background loop only fires every ~45 min) and answer with the same shape as
  // GET /api/state/update so the Settings "Check for updates" button is one call.
  router.post('/check', async (_req, res) => {
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
  router.post('/apply', (_req, res) => {
    const result = preflightUpdate(repoDir, opts?.gitExec);
    if (!result.ok) {
      res.status(409).json({ ok: false, reason: result.reason });
      return;
    }
    broadcaster.broadcast({ type: 'update:in-progress' });
    apply(repoDir);
    res.json({ ok: true });
  });

  return router;
}
