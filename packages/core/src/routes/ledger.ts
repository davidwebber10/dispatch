import { Router, type Request, type Response } from 'express';
import { LedgerError, type LedgerService } from '../overseer/ledger-service.js';

/**
 * The decision ledger routes. Every route names the caller in the body (`caller`, the calling
 * terminal id that the dispatch MCP takes from DISPATCH_TERMINAL) and the service rejects any
 * caller that is not this project's overseer — the same trust level as the other agency routes.
 * `list` is a POST because `forRecap` changes the overseer's config.
 */
export function createLedgerRouter(ledger: LedgerService): Router {
  const router = Router();

  const handle = (status: number, run: (req: Request) => unknown) => (req: Request, res: Response) => {
    try {
      res.status(status).json(run(req));
    } catch (e: any) {
      if (e instanceof LedgerError) return res.status(e.status).json({ error: e.message, ...e.body });
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  };

  router.post('/sessions/:sessionId/ledger', handle(201, (req) => ledger.add(req.params.sessionId, req.body?.caller, req.body ?? {})));
  router.post('/sessions/:sessionId/ledger/list', handle(200, (req) => ledger.list(req.params.sessionId, req.body?.caller, { forRecap: req.body?.forRecap === true })));
  router.post('/sessions/:sessionId/ledger/note', handle(201, (req) => ledger.note(req.params.sessionId, req.body?.caller, req.body ?? {})));
  router.post('/sessions/:sessionId/ledger/import', handle(201, (req) => ledger.importItems(req.params.sessionId, req.body?.caller, req.body?.items)));
  router.post('/sessions/:sessionId/ledger/handoff', handle(200, (req) => ledger.handoff(req.params.sessionId, req.body?.caller, req.body?.ids)));
  router.post('/sessions/:sessionId/ledger/:itemId/resolve', handle(200, (req) => ledger.resolve(req.params.sessionId, req.body?.caller, { ...(req.body ?? {}), id: req.params.itemId })));
  // Decision cards (spec 2026-10-06, Unit 4): triage and the card tools.
  router.post('/sessions/:sessionId/ledger/show', handle(200, (req) => ledger.show(req.params.sessionId, req.body?.caller, req.body ?? {})));
  router.post('/sessions/:sessionId/ledger/:itemId/add-from-agent', handle(200, (req) => ledger.addFromAgent(req.params.sessionId, req.body?.caller, { ...(req.body ?? {}), id: req.params.itemId })));
  router.post('/sessions/:sessionId/ledger/:itemId/decide-self', handle(200, (req) => ledger.decideSelf(req.params.sessionId, req.body?.caller, { ...(req.body ?? {}), id: req.params.itemId })));
  router.post('/sessions/:sessionId/ledger/:itemId/mark-default', handle(200, (req) => ledger.markDefault(req.params.sessionId, req.body?.caller, { ...(req.body ?? {}), id: req.params.itemId })));

  return router;
}
