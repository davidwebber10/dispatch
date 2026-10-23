import type { Router } from 'express';
import { policyRouter } from '../auth/route-policy.js';
import { listProviders } from '../providers/registry.js';

export function createProvidersRouter(): Router {
  const router = policyRouter();
  router.get('/', (_req, res) => {
    res.json(listProviders().map(p => ({ name: p.name, displayName: p.displayName })));
  });
  return router;
}
