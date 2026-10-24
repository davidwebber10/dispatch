import { type Request, type Response, type Router } from 'express';
import { keyRoute, policyRouter } from '../auth/route-policy.js';
import { ledgerRule } from '../auth/key-rules.js';
import { LedgerError, type LedgerService } from '../overseer/ledger-service.js';

/**
 * The decision ledger routes. Every route names the caller in the body (`caller`, the calling
 * terminal id that the dispatch MCP takes from DISPATCH_TERMINAL) and the service rejects any
 * caller that is not this project's overseer — the same trust level as the other agency routes.
 * `list` is a POST because `forRecap` changes the overseer's config.
 * `card` (pinned card spec 2026-10-08, Unit 2) and `source` (titles and source panel spec
 * 2026-10-09, Unit 8) are the GETs: they only read, and have no caller check, like the routes that
 * return conversations — the web app reads them.
 */
export function createLedgerRouter(ledger: LedgerService): Router {
  const router = policyRouter();

  const handle = (status: number, run: (req: Request) => unknown) => (req: Request, res: Response) => {
    try {
      res.status(status).json(run(req));
    } catch (e: any) {
      if (e instanceof LedgerError) return res.status(e.status).json({ error: e.message, ...e.body });
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  };

  router.get('/sessions/:sessionId/ledger/card', handle(200, (req) => ledger.card(req.params.sessionId)));
  router.get('/sessions/:sessionId/ledger/:itemId/source', handle(200, (req) =>
    ledger.source(req.params.sessionId, req.params.itemId, { heading: typeof req.query.heading === 'string' ? req.query.heading : undefined })));
  router.post('/sessions/:sessionId/ledger', keyRoute({ thread: ledgerRule }), handle(201, (req) => ledger.add(req.params.sessionId, req.body?.caller, req.body ?? {})));
  router.post('/sessions/:sessionId/ledger/list', keyRoute({ thread: ledgerRule }), handle(200, (req) => ledger.list(req.params.sessionId, req.body?.caller, { forRecap: req.body?.forRecap === true })));
  router.post('/sessions/:sessionId/ledger/note', keyRoute({ thread: ledgerRule }), handle(201, (req) => ledger.note(req.params.sessionId, req.body?.caller, req.body ?? {})));
  router.post('/sessions/:sessionId/ledger/import', keyRoute({ thread: ledgerRule }), handle(201, (req) => ledger.importItems(req.params.sessionId, req.body?.caller, req.body?.items)));
  router.post('/sessions/:sessionId/ledger/handoff', keyRoute({ thread: ledgerRule }), handle(200, (req) => ledger.handoff(req.params.sessionId, req.body?.caller, req.body?.ids)));
  router.post('/sessions/:sessionId/ledger/:itemId/resolve', keyRoute({ thread: ledgerRule }), handle(200, (req) => ledger.resolve(req.params.sessionId, req.body?.caller, { ...(req.body ?? {}), id: req.params.itemId })));
  // Decision cards (spec 2026-10-06, Unit 4): triage and the card tools.
  router.post('/sessions/:sessionId/ledger/show', keyRoute({ thread: ledgerRule }), handle(200, (req) => ledger.show(req.params.sessionId, req.body?.caller, req.body ?? {})));
  // ledger_decide_self without an item ID: the overseer records a new decision of its own, already decided.
  router.post('/sessions/:sessionId/ledger/decide-self', keyRoute({ thread: ledgerRule }), handle(201, (req) => ledger.decideSelf(req.params.sessionId, req.body?.caller, req.body ?? {})));
  router.post('/sessions/:sessionId/ledger/:itemId/add-from-agent', keyRoute({ thread: ledgerRule }), handle(200, (req) => ledger.addFromAgent(req.params.sessionId, req.body?.caller, { ...(req.body ?? {}), id: req.params.itemId })));
  router.post('/sessions/:sessionId/ledger/:itemId/decide-self', keyRoute({ thread: ledgerRule }), handle(200, (req) => ledger.decideSelf(req.params.sessionId, req.body?.caller, { ...(req.body ?? {}), id: req.params.itemId })));
  router.post('/sessions/:sessionId/ledger/:itemId/mark-default', keyRoute({ thread: ledgerRule }), handle(200, (req) => ledger.markDefault(req.params.sessionId, req.body?.caller, { ...(req.body ?? {}), id: req.params.itemId })));
  // Titles and source panel (spec 2026-10-09, Unit 2): the overseer sets or changes an item's title.
  router.post('/sessions/:sessionId/ledger/:itemId/title', keyRoute({ thread: ledgerRule }), handle(200, (req) => ledger.setTitle(req.params.sessionId, req.body?.caller, { ...(req.body ?? {}), id: req.params.itemId })));

  return router;
}
