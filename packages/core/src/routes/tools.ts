import { Router } from 'express';
import { toolStatuses } from '../tools/status.js';

export function createToolsRouter(opts?: { base?: string }): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    try { res.json({ tools: toolStatuses({ base: opts?.base }) }); }
    catch (e) { console.warn('GET /api/tools failed:', e); res.json({ tools: [] }); }
  });
  return router;
}
