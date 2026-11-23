import { harnessCapabilities } from '../providers/capabilities.js';
import type { Router } from 'express';
import { policyRouter } from '../auth/route-policy.js';
import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';
import type { SecretsService } from '../secrets/service.js';
import { detectAllProviders, detectTailscale, type ProviderStatus } from '../setup/detect.js';
import { claudeSignedIn } from '../auth/claude-login-sources.js';
import { installProvider, isProviderName, type ShellRunner } from '../setup/install.js';
import { clientMessage } from '../http/client-message.js';

const SETUP_KEY = 'setup_completed_at';
const port = () => Number(process.env.PORT) || 3456;

/** A provider as the app gets it. Claude carries two answers: the default account's, and the machine's own. */
type AppProviderStatus = ProviderStatus & { machineSignedIn?: boolean | 'unknown' };

/**
 * For the app, "Claude is signed in" means: the account a new thread runs on (the default Claude
 * account) is. The machine check alone is wrong for an install whose default is a saved sign-in:
 * the New Thread window and the Setup wizard would call a working install signed out (review of
 * #189, one source for the Claude login).
 */

async function providersForApp(list: ProviderStatus[]): Promise<AppProviderStatus[]> {
  const claude = list.find((p) => p.name === 'claude');
  if (!claude || !claude.installed) return list;
  // 'unknown' stays 'unknown': the answer of one login is never borrowed for another (review round 2).
  // `machineSignedIn` is the machine's own answer, for a thread the person puts on the CLI login.
  const signedIn = await claudeSignedIn().catch(() => 'unknown' as const);
  return list.map((p) => (p === claude ? { ...p, signedIn, machineSignedIn: p.signedIn } : p));
}

export function createSetupRouter(db: Database.Database, secrets: SecretsService, runInstall?: ShellRunner): Router {
  const router = policyRouter();
  router.get('/harnesses', (_req, res) => res.json(harnessCapabilities()));

  router.get('/state', async (_req, res) => {
    const [providers, tailscale] = await Promise.all([detectAllProviders().then(providersForApp), detectTailscale(port())]);
    res.json({
      firstRun: appState.get(db, SETUP_KEY) === null,
      providers,
      tailscale,
      secrets: { connected: secrets.status().connected },
    });
  });

  // ?fresh=1 bypasses the signed-in cache. The Setup wizard's Re-check button uses it —
  // that is pressed right after signing in, the one moment a cached answer is wrong. The
  // New Thread modal omits it, so opening the modal repeatedly does not spawn three
  // status processes each time.
  router.get('/providers', async (req, res) =>
    res.json(await providersForApp(await detectAllProviders({ fresh: req.query.fresh === '1' || req.query.fresh === 'true' }))));
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
      res.status(500).json({ error: clientMessage(err) });
    }
  });

  return router;
}
