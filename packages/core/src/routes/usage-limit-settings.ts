import type { Router } from 'express';
import { policyRouter } from '../auth/route-policy.js';
import type Database from 'better-sqlite3';
import * as gaugeSettings from '../limits/gauge-settings.js';

/**
 * GET/PUT /api/settings/usage-limits: the warning threshold and the push switch (#127).
 * PUT takes either field. `warnPercent` must be a number (rounded, then clamped to 50..99);
 * `pushOnWarn` a boolean. `onChange` applies the new values live (the gauge recolors every client).
 */
export function createUsageLimitSettingsRouter(db: Database.Database, opts: { onChange?: () => void } = {}): Router {
  const router = policyRouter();
  router.get('/', (_req, res) => { res.json(gaugeSettings.get(db)); });
  router.put('/', (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const patch: Partial<gaugeSettings.UsageLimitSettings> = {};
    if ('warnPercent' in b) {
      const w = gaugeSettings.sanitizeWarn(b.warnPercent);
      if (w === null) { res.status(400).json({ error: 'warnPercent must be a number' }); return; }
      patch.warnPercent = w;
    }
    if ('pushOnWarn' in b) {
      if (typeof b.pushOnWarn !== 'boolean') { res.status(400).json({ error: 'pushOnWarn must be a boolean' }); return; }
      patch.pushOnWarn = b.pushOnWarn;
    }
    if (Object.keys(patch).length === 0) { res.status(400).json({ error: 'warnPercent or pushOnWarn is required' }); return; }
    const next = gaugeSettings.set(db, patch);
    try { opts.onChange?.(); } catch (err) { console.warn('[usage-limit] settings change hook failed:', err); }
    res.json(next);
  });
  return router;
}
