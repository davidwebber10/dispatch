import { Router } from 'express';
import type { IntegrationsService, AddIntegrationInput, IntegrationsExport } from '../integrations/service.js';

export function createIntegrationsRouter(integrations: IntegrationsService): Router {
  const router = Router();

  router.get('/', (_req, res) => res.json({ integrations: integrations.list() }));

  router.post('/', (req, res) => {
    const err = (integrations.constructor as typeof IntegrationsService).validate(req.body);
    if (err) return res.status(400).json({ error: err });
    try {
      res.json(integrations.add(req.body as AddIntegrationInput));
    } catch (e: any) {
      const msg = String(e?.message ?? 'add failed');
      res.status(/exists/.test(msg) ? 409 : 502).json({ error: /exists/.test(msg) ? msg : 'Could not add the integration.' });
    }
  });

  router.patch('/:id', (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) required' });
    const updated = integrations.setEnabled(req.params.id, req.body.enabled);
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json(updated);
  });

  router.delete('/:id', (req, res) => res.json(integrations.remove(req.params.id)));

  router.get('/export', (_req, res) => res.json(integrations.export()));

  router.post('/import', (req, res) => {
    try {
      res.json(integrations.import(req.body as IntegrationsExport));
    } catch {
      res.status(400).json({ error: 'Invalid import document.' });
    }
  });

  return router;
}
