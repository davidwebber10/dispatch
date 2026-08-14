import { Router } from 'express';
import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';
import type { SecretsService } from '../secrets/service.js';
import { detectAllProviders, detectTailscale } from '../setup/detect.js';
import { installProvider, isProviderName, type ShellRunner } from '../setup/install.js';

const SETUP_KEY = 'setup_completed_at';
const port = () => Number(process.env.PORT) || 3456;

export function createSetupRouter(db: Database.Database, secrets: SecretsService, runInstall?: ShellRunner): Router {
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

  // POST /api/setup/install/:provider — run that CLI's own documented install one-liner,
  // then re-detect. The provider name is validated against the known set BEFORE it is used
  // to look up a constant command, so no request can influence what runs in the shell.
  //
  // This can take minutes (Grok ships a ~130MB binary), so the client shows progress and
  // waits. Installing never signs the CLI in — the response carries the login command for
  // the user to run in a real terminal, because those flows are interactive.
  router.post('/install/:provider', async (req, res) => {
    const name = String(req.params.provider);
    if (!isProviderName(name)) return res.status(400).json({ error: `Unknown provider: ${name}` });
    try {
      res.json(await installProvider(name, runInstall));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
