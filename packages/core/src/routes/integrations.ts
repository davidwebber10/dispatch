import type { Router } from 'express';
import { keyRoute, policyRouter } from '../auth/route-policy.js';
import { allowRule } from '../auth/key-rules.js';
import { creatorOf } from '../auth/creator.js';
import type { IntegrationsService, AddIntegrationInput, IntegrationsExport } from '../integrations/service.js';

export function createIntegrationsRouter(integrations: IntegrationsService): Router {
  const router = policyRouter();

  router.get('/', (_req, res) => res.json({ integrations: integrations.list() }));

  // SEC-20: a thread with its own key may create this (never blocked); the route records the thread as the creator.
  // Only `thread` has a rule, so a role run, a shell and Chat stay owner only and a scheduled run cannot add the next schedule.
  router.post('/', keyRoute({ thread: allowRule }), (req, res) => {
    const err = integrations.validateInput(req.body);
    if (err) return res.status(400).json({ error: err });
    try {
      res.json(integrations.add(req.body as AddIntegrationInput, creatorOf(req)));
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

  router.delete('/:id', (req, res) => {
    try { res.json(integrations.remove(req.params.id)); }
    catch { res.status(500).json({ error: 'Could not remove the integration.' }); }
  });

  router.get('/export', (_req, res) => res.json(integrations.export()));

  router.post('/import', (req, res) => {
    if (!Array.isArray(req.body?.integrations)) return res.status(400).json({ error: 'Invalid import document.' });
    try {
      res.json(integrations.import(req.body as IntegrationsExport, creatorOf(req)));
    } catch {
      res.status(400).json({ error: 'Invalid import document.' });
    }
  });

  return router;
}
