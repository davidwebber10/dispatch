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
 * The instant recording began, stamped once on first read. The history importer
 * accepts only turns OLDER than this, so imported and live rows can never
 * describe the same turn — that boundary is what makes the import button safe to
 * press twice.
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

  router.get('/backfill', (_req, res) => {
    res.json({ trackingStartedAt: trackingStartedAt(db), ...readBackfillState(db) });
  });

  return router;
}

export interface BackfillState {
  state: 'idle' | 'running' | 'done' | 'error';
  done: number;
  total: number;
  lastFinishedAt: string | null;
  error?: string;
}

const BACKFILL_KEY = 'analytics_backfill_state';

export function readBackfillState(db: Database.Database): BackfillState {
  const raw = appState.get(db, BACKFILL_KEY);
  if (!raw) return { state: 'idle', done: 0, total: 0, lastFinishedAt: null };
  try { return JSON.parse(raw) as BackfillState; }
  catch { return { state: 'idle', done: 0, total: 0, lastFinishedAt: null }; }
}

export function writeBackfillState(db: Database.Database, s: BackfillState): void {
  appState.set(db, BACKFILL_KEY, JSON.stringify(s));
}
