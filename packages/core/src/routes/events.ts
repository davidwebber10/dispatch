import type { Router } from 'express';
import { policyRouter } from '../auth/route-policy.js';
import type { StatusService } from '../status/service.js';

/** Receives provider lifecycle events: POST /api/events/:provider/:terminalId (claude|codex|grok). */
export function createEventsRouter(status: StatusService): Router {
  const router = policyRouter();
  router.post('/:provider/:terminalId', (req, res) => {
    try { status.ingest(req.params.provider, req.params.terminalId, req.body ?? {}); } catch { /* never fail the hook */ }
    res.status(204).end();
  });
  return router;
}
