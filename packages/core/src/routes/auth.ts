import { Router } from 'express';
import type { AuthRequestService } from '../auth/service.js';

export function createAuthRouter(service: AuthRequestService): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(service.list());
  });

  router.post('/', (req, res) => {
    try {
      const record = service.create({
        url: String(req.body.url || ''),
        source: req.body.source,
        terminalId: req.body.terminalId,
        cwd: req.body.cwd,
      });
      res.status(201).json(record);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/:id/opened', (req, res) => {
    const record = service.markOpened(req.params.id);
    if (!record) return res.status(404).json({ error: 'Auth request not found' });
    res.json(record);
  });

  router.post('/:id/complete', (req, res) => {
    const record = service.markComplete(req.params.id);
    if (!record) return res.status(404).json({ error: 'Auth request not found' });
    res.json(record);
  });

  router.post('/:id/callback', async (req, res) => {
    try {
      const record = await service.forwardLoopbackCallback(req.params.id, String(req.body.url || ''));
      if (!record) return res.status(404).json({ error: 'Auth request not found' });
      res.json(record);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}
