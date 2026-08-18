import { Router } from 'express';
import type Database from 'better-sqlite3';
import { readHarnessSettings, updateHarnessSettings, opencodeKeySecretName } from '../settings/harness-settings.js';

/** The narrow secrets surface this router needs (SecretsService satisfies it). */
export interface SecretsLike {
  getSecret(name: string): Promise<string | null>;
}

/**
 * GET  /api/settings/harnesses — the per-harness settings, plus `opencodeKey`: which secret
 *      name is in effect and whether it currently RESOLVES in Doppler (`present`). The key's
 *      VALUE never crosses this wire — presence is a boolean, per the transcription pattern.
 * PUT  /api/settings/harnesses — field-wise merge per harness (null clears a field). Fires
 *      `onChanged` so the server wiring re-resolves the opencode spawn env immediately —
 *      renaming the secret takes effect on the very next spawn, no restart.
 */
export function createHarnessSettingsRouter(db: Database.Database, secrets?: SecretsLike, onChanged?: () => void): Router {
  const router = Router();

  const keyStatus = async () => {
    const secret = opencodeKeySecretName(db);
    let present = false;
    try { present = !!secrets && !!(await secrets.getSecret(secret)); } catch { /* not connected → absent */ }
    return { secret, present };
  };

  router.get('/', async (_req, res) => {
    res.json({ settings: readHarnessSettings(db), opencodeKey: await keyStatus() });
  });

  router.put('/', async (req, res) => {
    const settings = updateHarnessSettings(db, req.body);
    onChanged?.();
    res.json({ settings, opencodeKey: await keyStatus() });
  });

  return router;
}
