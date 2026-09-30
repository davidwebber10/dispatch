import { Router } from 'express';
import { toolStatuses } from '../tools/status.js';
import type { ToolAuthProber } from '../tools/auth-probe.js';

export function createToolsRouter(opts?: { base?: string; prober?: ToolAuthProber }): Router {
  const router = Router();
  // Waits for the auth checks when the cache is stale or the caller asks (?refresh=1, the
  // page's "Check again"); the prober dedupes, so concurrent loads share one run.
  router.get('/', async (req, res) => {
    const prober = opts?.prober;
    try {
      if (prober && (req.query.refresh === '1' || prober.isStale())) await prober.refresh();
      const snap = prober?.snapshot();
      res.json({ tools: toolStatuses({ base: opts?.base, env: prober?.threadEnv(), checks: snap?.results }), checkedAt: snap?.checkedAt ?? null });
    } catch (e) { console.warn('GET /api/tools failed:', e); res.json({ tools: [], checkedAt: null }); }
  });
  return router;
}
