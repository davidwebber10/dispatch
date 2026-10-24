import type { Router } from 'express';
import { policyRouter } from '../auth/route-policy.js';
import type Database from 'better-sqlite3';
import { setTelemetryEnabled, telemetryEnabled } from '../telemetry/sender.js';

/** GET/PUT /api/settings/telemetry — the "Send anonymous usage stats" switch. */
export function createTelemetrySettingsRouter(db: Database.Database): Router {
  const router = policyRouter();
  const view = () => ({ enabled: telemetryEnabled(db, {}) });
  router.get('/', (_req, res) => { res.json(view()); });
  router.put('/', (req, res) => {
    const on = req.body?.enabled;
    if (typeof on !== 'boolean') { res.status(400).json({ error: 'enabled (boolean) is required' }); return; }
    setTelemetryEnabled(db, on);
    res.json(view());
  });
  return router;
}
