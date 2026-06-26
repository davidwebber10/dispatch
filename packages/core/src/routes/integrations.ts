import { Router } from 'express';
import type { IntegrationsService, AddIntegrationInput } from '../integrations/service.js';

/** Validate a POST body as an AddIntegrationInput. Returns an error string or null. */
function validateAddInput(b: any): string | null {
  if (!b || typeof b !== 'object') return 'body required';
  const s = (v: any) => typeof v === 'string' && v.trim().length > 0;
  switch (b.type) {
    case 'openapi': return s(b.url) && s(b.slug) ? null : 'openapi requires url and slug';
    case 'mcp-stdio': return s(b.name) && s(b.command) && Array.isArray(b.args) && b.args.every((a: any) => typeof a === 'string') ? null : 'mcp-stdio requires name, command, and string[] args';
    case 'mcp-remote': return s(b.name) && s(b.endpoint) ? null : 'mcp-remote requires name and endpoint';
    case 'graphql': return s(b.endpoint) && s(b.slug) ? null : 'graphql requires endpoint and slug';
    default: return `unknown integration type: ${String(b.type)}`;
  }
}

export function createIntegrationsRouter(integrations: IntegrationsService): Router {
  const router = Router();

  router.get('/status', (_req, res) => res.json(integrations.status()));

  router.get('/', async (_req, res) => {
    if (!integrations.status().installed) return res.json({ installed: false, integrations: [] });
    try {
      const list = await integrations.list();
      res.json({ installed: true, integrations: list });
    } catch (e: any) {
      res.status(502).json({ error: e?.message ?? 'executor error' });
    }
  });

  router.post('/', async (req, res) => {
    if (!integrations.status().installed) return res.status(409).json({ error: 'executor not installed' });
    const err = validateAddInput(req.body);
    if (err) return res.status(400).json({ error: err });
    try {
      const result = await integrations.add(req.body as AddIntegrationInput);
      res.json(result);
    } catch (e: any) {
      res.status(502).json({ error: e?.message ?? 'add failed' });
    }
  });

  router.delete('/:slug', async (req, res) => {
    if (!integrations.status().installed) return res.status(409).json({ error: 'executor not installed' });
    try {
      const result = await integrations.remove(req.params.slug);
      res.json(result);
    } catch (e: any) {
      res.status(502).json({ error: e?.message ?? 'remove failed' });
    }
  });

  return router;
}
