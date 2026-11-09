import type { Router } from 'express';
import type Database from 'better-sqlite3';
import { ownerOnlyStrict, policyRouter } from '../auth/route-policy.js';
import * as terminalsDb from '../db/terminals.js';
import { ThreadConfigStore } from '../sessions/thread-config.js';

export interface ThreadSecretsOptions {
  /** Tells the open pages that the thread's config changed. */
  broadcast?: (event: { type: 'session:tabs-changed'; sessionId: string }) => void;
}

const NEXT_SPAWN = 'The change takes effect at the next start of the thread. Reload the thread to apply it now.';

/**
 * PUT /api/terminals/:id/secrets-env { enabled: boolean }
 *
 * Turns the Doppler token on or off for one thread (config key `secretsEnv`). It matters only
 * with the token scope `opted-in` (SecretsService.getThreadTokenEnv). Owner only, and a caller
 * with no credential must be the web page: a thread must not give itself the token.
 *
 * The write is a patch of the one key through ThreadConfigStore, so it cannot drop another
 * writer's key.
 */
export function createThreadSecretsRouter(db: Database.Database, opts: ThreadSecretsOptions = {}): Router {
  const router = policyRouter();

  const store = new ThreadConfigStore(db);
  const setKey = (id: string, enabled: boolean): { sessionId: string } | null => {
    const row = terminalsDb.getById(db, id);
    if (!row) return null;
    store.patch(id, { secretsEnv: enabled ? true : null });
    return { sessionId: row.session_id };
  };

  router.put('/terminals/:id/secrets-env', ownerOnlyStrict, (req, res) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') { res.status(400).json({ error: 'enabled (boolean) is required' }); return; }
    const done = setKey(req.params.id, enabled);
    if (!done) { res.status(404).json({ error: 'thread not found' }); return; }
    opts.broadcast?.({ type: 'session:tabs-changed', sessionId: done.sessionId });
    res.json({ id: req.params.id, secretsEnv: enabled, appliesAt: 'next-spawn', message: NEXT_SPAWN });
  });

  return router;
}
