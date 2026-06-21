import { Router } from 'express';
import type { SecretsService } from '../secrets/service.js';

/** Maps a thrown error to 400 (caller/config problem) or 502 (Doppler upstream). */
function fail(res: import('express').Response, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  const client = /not connected|required|read-only|invalid/i.test(msg);
  res.status(client ? 400 : 502).json({ error: msg });
}

export function createSecretsRouter(secrets: SecretsService): Router {
  const router = Router();

  // Status never includes the token.
  router.get('/status', (_req, res) => res.json(secrets.status()));

  router.put('/connection', async (req, res) => {
    try { res.json(await secrets.setConnection(req.body ?? {})); }
    catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : String(e) }); }
  });

  // Literal /connection must be declared before the /:name delete route below.
  router.delete('/connection', (_req, res) => res.json(secrets.disconnect()));

  router.get('/projects', async (_req, res) => {
    try { res.json(await secrets.listProjects()); } catch (e) { fail(res, e); }
  });

  router.get('/configs', async (req, res) => {
    try { res.json(await secrets.listConfigs(String(req.query.project ?? ''))); } catch (e) { fail(res, e); }
  });

  router.get('/', async (req, res) => {
    try {
      res.json(await secrets.listSecrets(
        req.query.project ? String(req.query.project) : undefined,
        req.query.config ? String(req.query.config) : undefined,
      ));
    } catch (e) { fail(res, e); }
  });

  router.post('/', async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) { res.status(400).json({ error: 'name is required' }); return; }
    try { await secrets.setSecret(name, String(req.body?.value ?? '')); res.status(204).end(); }
    catch (e) { fail(res, e); }
  });

  router.delete('/:name', async (req, res) => {
    try { await secrets.deleteSecret(req.params.name); res.status(204).end(); } catch (e) { fail(res, e); }
  });

  return router;
}
