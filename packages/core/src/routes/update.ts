import { Router } from 'express';
import type { EventBroadcaster } from '../ws/events.js';
import { applyUpdate, preflightUpdate, type GitExec } from '../update/apply.js';

export interface CreateUpdateRouterOptions {
  /** Test seam: inject a fake git runner instead of shelling out to real git. */
  gitExec?: GitExec;
  /** Test seam: replace the real detached-spawn of `bin/dispatch update`. */
  applyFn?: (repoDir: string) => void;
}

export function createUpdateRouter(broadcaster: EventBroadcaster, repoDir: string, opts?: CreateUpdateRouterOptions): Router {
  const router = Router();
  const apply = opts?.applyFn ?? applyUpdate;

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
