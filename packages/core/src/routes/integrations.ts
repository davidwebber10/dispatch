import { Router } from 'express';
import { IntegrationsService } from '../integrations/service.js';
import type { AddIntegrationInput } from '../integrations/service.js';

export function createIntegrationsRouter(integrations: IntegrationsService): Router {
  const router = Router();

  // Always "installed" now — integrations live in the local DB.
  router.get('/status', (_req, res) => res.json({ installed: true }));

  router.get('/', (_req, res) => {
    try {
      res.json({ installed: true, integrations: integrations.list() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', (req, res) => {
    const err = IntegrationsService.validate(req.body);
    if (err) return res.status(400).json({ error: err });
    try {
      const result = integrations.add(req.body as AddIntegrationInput);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.patch('/:id/enabled', (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
    const result = integrations.setEnabled(req.params.id, enabled);
    if (!result) return res.status(404).json({ error: 'integration not found' });
    res.json(result);
  });

  router.delete('/:id', (req, res) => {
    try {
      const result = integrations.remove(req.params.id);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
