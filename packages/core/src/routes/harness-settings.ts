import { Router } from 'express';
import type Database from 'better-sqlite3';
import { readHarnessSettings, updateHarnessSettings, opencodeKeySecretName, opencodeModels } from '../settings/harness-settings.js';
import { loadCatalog, searchCatalog } from '../settings/openrouter-catalog.js';

/** The narrow secrets surface this router needs (SecretsService satisfies it). */
export interface SecretsLike {
  getSecret(name: string): Promise<string | null>;
}

export interface HarnessSettingsRouterOptions {
  /** Test seam for the OpenRouter catalog fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * GET  /api/settings/harnesses — the per-harness settings, plus `opencodeKey`: which secret
 *      name is in effect and whether it currently RESOLVES in Doppler (`present`). The key's
 *      VALUE never crosses this wire — presence is a boolean, per the transcription pattern.
 *      Also `opencodeModels`: the EFFECTIVE picker list (the user's, else the curated
 *      defaults), so the web never has to know the defaults.
 * PUT  /api/settings/harnesses — field-wise merge per harness (null clears a field). Fires
 *      `onChanged` so the server wiring re-resolves the opencode spawn env immediately —
 *      renaming the secret takes effect on the very next spawn, no restart.
 * GET  /api/settings/harnesses/opencode/catalog?q= — search OpenRouter's public catalog for
 *      the "add a model" box. 502 when OpenRouter is unreachable, so the UI can say so
 *      rather than show an empty result.
 */
export function createHarnessSettingsRouter(db: Database.Database, secrets?: SecretsLike, onChanged?: () => void, opts: HarnessSettingsRouterOptions = {}): Router {
  const router = Router();

  const keyStatus = async () => {
    const secret = opencodeKeySecretName(db);
    let present = false;
    try { present = !!secrets && !!(await secrets.getSecret(secret)); } catch { /* not connected → absent */ }
    return { secret, present };
  };

  const payload = async () => ({ settings: readHarnessSettings(db), opencodeKey: await keyStatus(), opencodeModels: opencodeModels(db) });

  router.get('/', async (_req, res) => {
    res.json(await payload());
  });

  router.put('/', async (req, res) => {
    updateHarnessSettings(db, req.body);
    onChanged?.();
    res.json(await payload());
  });

  router.get('/opencode/catalog', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    try {
      const entries = await loadCatalog(opts.fetchImpl);
      res.json(searchCatalog(entries, q));
    } catch (err) {
      res.status(502).json({ error: `Could not reach the OpenRouter catalog: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  return router;
}
