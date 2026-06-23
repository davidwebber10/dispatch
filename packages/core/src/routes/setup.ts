import { Router } from 'express';
import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';
import type { SecretsService } from '../secrets/service.js';
import { detectAllProviders, detectTailscale } from '../setup/detect.js';

const SETUP_KEY = 'setup_completed_at';
const port = () => Number(process.env.PORT) || 3456;

export function createSetupRouter(db: Database.Database, secrets: SecretsService): Router {
  const router = Router();

  router.get('/state', async (_req, res) => {
    const [providers, tailscale] = await Promise.all([detectAllProviders(), detectTailscale(port())]);
    res.json({
      firstRun: appState.get(db, SETUP_KEY) === null,
      providers,
      tailscale,
      secrets: { connected: secrets.status().connected },
    });
  });

  router.get('/providers', async (_req, res) => res.json(await detectAllProviders()));
  router.get('/tailscale', async (_req, res) => res.json(await detectTailscale(port())));
  router.post('/complete', (_req, res) => { appState.set(db, SETUP_KEY, new Date().toISOString()); res.json({ ok: true }); });

  return router;
}
