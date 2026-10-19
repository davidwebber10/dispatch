import { Router } from 'express';
import { LedgerError } from '../overseer/ledger-service.js';
import { EndlessService, UserError } from '../endless/service.js';

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const int = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Endless Chat HTTP surface (spec 2026-10-13, section 2). Live events ride the events socket. */
export function createEndlessRouter(svc: EndlessService): Router {
  const router = Router();
  router.use((_req, res, next) => {
    if (svc.available) next();
    else res.status(503).json({ error: 'Chat is unavailable' });
  });
  const fail = (res: any, err: unknown) => {
    if (err instanceof UserError) res.status(400).json({ error: err.message });
    else res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  };

  router.get('/messages', (req, res) => {
    const project = str(req.query.project);
    const limit = int(req.query.limit, 50, 1, 200);
    if (req.query.around !== undefined) { res.json(svc.around(int(req.query.around, 0, 0, Number.MAX_SAFE_INTEGER), limit, project)); return; }
    const before = req.query.before !== undefined ? int(req.query.before, 0, 0, Number.MAX_SAFE_INTEGER) : undefined;
    res.json(svc.page({ before, limit, project }));
  });

  router.post('/send', (req, res) => {
    const { text, project, images } = req.body ?? {};
    try {
      svc.send({ text: typeof text === 'string' ? text : '', project: str(project), images: Array.isArray(images) ? images : [] });
      res.status(202).json({ ok: true });
    } catch (err) { fail(res, err); }
  });

  router.post('/retry', (_req, res) => {
    if (svc.retry()) res.status(202).json({ ok: true });
    else res.status(409).json({ error: 'a turn is running, or there is no message to retry' });
  });

  router.post('/stop', (_req, res) => {
    if (svc.stopTurn()) res.status(202).json({ ok: true });
    else res.status(409).json({ error: 'no turn is running' });
  });

  router.get('/state', (_req, res) => { res.json(svc.state()); });

  router.get('/search', (req, res) => {
    res.json({ results: svc.search(String(req.query.q ?? ''), str(req.query.project), int(req.query.limit, 50, 1, 200)) });
  });

  router.get('/view', (_req, res) => { res.json(svc.viewLines()); });
  router.get('/projects', (_req, res) => { res.json(svc.projects()); });
  // Read only: a spec or plan doc under a registered project folder (main, a worktree or an unmerged branch).
  router.get('/doc', (req, res) => {
    const r = svc.docs.doc(String(req.query.project ?? ''), String(req.query.path ?? ''), str(req.query.branch));
    if (!r) { res.status(400).json({ error: 'unknown project' }); return; }
    if (r.kind === 'doc') res.json(r.doc);
    else if (r.kind === 'refused') res.status(403).json({ reason: r.reason });
    else if (r.kind === 'too_large') res.status(413).json({ path: r.path, size: r.size });
    else res.status(404).json({ looked: r.looked });
  });
  // Read only: the in-progress docs of a project, and their totals for the projects the pane shows.
  router.get('/docs', async (req, res) => {
    try {
      const r = await svc.docs.list(String(req.query.project ?? ''));
      if (!r) { res.status(400).json({ error: 'unknown project' }); return; }
      res.json(r);
    } catch (err) { fail(res, err); }
  });
  router.get('/docs/counts', async (req, res) => {
    try {
      const ids = String(req.query.projects ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      res.json({ counts: await svc.docs.counts(ids) });
    } catch (err) { fail(res, err); }
  });
  router.get('/threads', (_req, res) => { res.json(svc.threads()); });
  router.get('/project', (req, res) => {
    try { res.json(svc.project(String(req.query.ref ?? ''))); } catch (err) { fail(res, err); }
  });
  router.post('/arm', (req, res) => {
    try { res.json(svc.arm(String(req.body?.terminalId ?? ''))); } catch (err) { fail(res, err); }
  });
  router.post('/disarm', (req, res) => {
    try { res.json(svc.disarm(String(req.body?.terminalId ?? ''))); } catch (err) { fail(res, err); }
  });

  router.post('/ledger/:action', (req, res) => {
    try { res.json(svc.ledger(req.params.action, req.body ?? {})); }
    catch (err) {
      if (err instanceof LedgerError) res.status(err.status).json({ error: err.message, ...err.body });
      else fail(res, err);
    }
  });

  router.get('/zoom', (req, res) => {
    try { res.json(svc.zoom(Number(req.query.id), Number(req.query.n))); } catch (err) { fail(res, err); }
  });

  router.get('/date', (req, res) => {
    try { res.json({ text: svc.date(Number(req.query.id)) }); } catch (err) { fail(res, err); }
  });

  router.get('/instructions', (_req, res) => { res.json({ text: svc.instructions() }); });
  router.put('/instructions', (req, res) => {
    svc.setInstructions(typeof req.body?.text === 'string' ? req.body.text : '');
    res.json({ ok: true });
  });

  router.get('/media/:name', (req, res) => {
    const file = svc.mediaFile(req.params.name);
    if (!file) { res.status(404).end(); return; }
    res.sendFile(file);
  });

  return router;
}
