import { Router } from 'express';
import type { IntegrationsService } from '../integrations/service.js';

export function createIntegrationsRouter(integrations: IntegrationsService): Router {
  const router = Router();
  router.get('/status', (_req, res) => res.json(integrations.status()));
  return router;
}
