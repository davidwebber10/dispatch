import { Router } from 'express';
import { listProviders } from '../providers/registry.js';

export function createProvidersRouter(): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.json(listProviders().map(p => ({ name: p.name, displayName: p.displayName })));
  });
  return router;
}
