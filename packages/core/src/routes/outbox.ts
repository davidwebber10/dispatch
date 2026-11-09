import type { Router } from 'express';
import { policyRouter } from '../auth/route-policy.js';
import type { DeliveryOutbox, OutboxState } from '../delivery/outbox.js';

const STATES: ReadonlySet<string> = new Set(['pending', 'delivered', 'dropped']);

/**
 * GET /api/outbox?terminalId=&state=&limit= : the rows of the delivery outbox (W2-C), newest first.
 * Owner only (policyRouter's default): a body is a message between threads. Read-only; it is here so
 * a person can see why a notice has not arrived. W2-G shows the same rows in the thread's "why" panel.
 */
export function createOutboxRouter(outbox: DeliveryOutbox): Router {
  const router = policyRouter();
  router.get('/', (req, res) => {
    const terminalId = typeof req.query.terminalId === 'string' && req.query.terminalId ? req.query.terminalId : undefined;
    const state = typeof req.query.state === 'string' && req.query.state ? req.query.state : undefined;
    if (state && !STATES.has(state)) return void res.status(400).json({ error: "state must be 'pending', 'delivered' or 'dropped'" });
    const limit = Number(req.query.limit);
    res.json(outbox.list({ terminalId, state: state as OutboxState | undefined, ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}) }));
  });
  return router;
}
