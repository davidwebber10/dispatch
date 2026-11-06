import type { Router } from 'express';
import { policyRouter } from '../auth/route-policy.js';
import type Database from 'better-sqlite3';
import { readDictationSettings, updateDictationSettings, readCoordinatorSettings, updateCoordinatorSettings } from '../settings/shared-settings.js';

/**
 * GET/PUT /api/settings/dictation   — { provider?, model?, secretName?, saved }
 * GET/PUT /api/settings/coordinator — { name?, saved }
 *
 * Owner only (policyRouter's default), like the harness settings. PUT merges field-wise (null clears).
 * `saved` is false until the first PUT, which is how a browser knows to upload its old per-device values once.
 */
export function createDictationSettingsRouter(db: Database.Database): Router {
  const router = policyRouter();
  router.get('/', (_req, res) => { res.json(readDictationSettings(db)); });
  router.put('/', (req, res) => { res.json(updateDictationSettings(db, req.body)); });
  return router;
}

export function createCoordinatorSettingsRouter(db: Database.Database): Router {
  const router = policyRouter();
  router.get('/', (_req, res) => { res.json(readCoordinatorSettings(db)); });
  router.put('/', (req, res) => { res.json(updateCoordinatorSettings(db, req.body)); });
  return router;
}
