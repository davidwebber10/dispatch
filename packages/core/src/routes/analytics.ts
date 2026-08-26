import { Router } from 'express';
import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';
import { summary, series, top, records } from '../analytics/queries.js';
import type { Metric, GroupBy, Dimension } from '../analytics/queries.js';

const METRICS: ReadonlySet<string> = new Set(['tokens', 'outputTokens', 'turns', 'duration']);
const GROUPS: ReadonlySet<string> = new Set(['model', 'provider', 'project', 'outcome', 'none']);
const DIMENSIONS: ReadonlySet<string> = new Set(['project', 'thread', 'model']);

export const TRACKING_KEY = 'analytics_tracking_started_at';

/**
 * The instant recording began, stamped once and never moved.
 *
 * `bootAnalytics` (server.ts) calls this on every app start, BEFORE any route is
 * mounted, so the value is the instant the recorder began recording. Analytics
 * is live recording from this instant and nothing else — the history importer
 * was removed by decision (nothing may write turns for the time before this
 * stamp), so the charts' honest floor is exactly this moment.
 *
 * Stamping it on first read instead would put the start at "the first time
 * someone opened the Analytics view", misstating when measurement really began.
 */
export function trackingStartedAt(db: Database.Database): string {
  const existing = appState.get(db, TRACKING_KEY);
  if (existing) return existing;
  const now = new Date().toISOString();
  appState.set(db, TRACKING_KEY, now);
  return now;
}

export function createAnalyticsRouter(db: Database.Database): Router {
  const router = Router();

  const range = (q: Record<string, any>) => ({
    from: typeof q.from === 'string' ? q.from : undefined,
    to: typeof q.to === 'string' ? q.to : undefined,
    projectId: typeof q.projectId === 'string' ? q.projectId : undefined,
    // No allow-list here: unlike metric/groupBy/dimension, provider is never
    // interpolated into SQL — it only ever reaches queries.ts as a bound `?`
    // parameter (see where() in analytics/queries.ts), so there is nothing for
    // an allow-list to protect against.
    provider: typeof q.provider === 'string' ? q.provider : undefined,
  });

  router.get('/summary', (req, res) => {
    res.json(summary(db, range(req.query)));
  });

  router.get('/series', (req, res) => {
    const metric = String(req.query.metric ?? 'tokens');
    const groupBy = String(req.query.groupBy ?? 'none');
    if (!METRICS.has(metric)) { res.status(400).json({ error: `unknown metric: ${metric}` }); return; }
    if (!GROUPS.has(groupBy)) { res.status(400).json({ error: `unknown groupBy: ${groupBy}` }); return; }
    res.json(series(db, { ...range(req.query), metric: metric as Metric, groupBy: groupBy as GroupBy }));
  });

  router.get('/top', (req, res) => {
    const dimension = String(req.query.dimension ?? 'project');
    if (!DIMENSIONS.has(dimension)) { res.status(400).json({ error: `unknown dimension: ${dimension}` }); return; }
    res.json(top(db, { ...range(req.query), dimension: dimension as Dimension }));
  });

  router.get('/records', (_req, res) => {
    res.json(records(db));
  });

  // When measurement began — the honest floor under every chart. The old
  // /backfill routes are gone with the history importer; nothing may write
  // turns for the time before this stamp.
  router.get('/tracking', (_req, res) => {
    res.json({ trackingStartedAt: trackingStartedAt(db) });
  });

  return router;
}
