import { Router } from 'express';
import type { StatusService } from '../status/service.js';

/** Receives provider lifecycle events: POST /api/events/:provider/:terminalId (claude|codex). */
export function createEventsRouter(status: StatusService): Router {
  const router = Router();
  router.post('/:provider/:terminalId', (req, res) => {
    try { status.ingest(req.params.provider, req.params.terminalId, req.body ?? {}); } catch { /* never fail the hook */ }
    res.status(204).end();
  });
  return router;
}
