import { Router } from 'express';
import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';
import { summary, series, top, records } from '../analytics/queries.js';
import type { Metric, GroupBy, Dimension } from '../analytics/queries.js';
import * as terminalsDb from '../db/terminals.js';
import * as sessionsDb from '../db/sessions.js';
import { importHistory } from '../analytics/importer.js';
import { HISTORY_IMPORT_STRATEGY } from '../analytics/history-import-strategy.js';
import * as usageDb from '../db/usage.js';
import { readBackfillState, writeBackfillState } from '../analytics/backfill-state.js';
import { isAgentType } from '../providers/agent-types.js';

const METRICS: ReadonlySet<string> = new Set(['tokens', 'outputTokens', 'turns', 'duration']);
const GROUPS: ReadonlySet<string> = new Set(['model', 'provider', 'project', 'outcome', 'none']);
const DIMENSIONS: ReadonlySet<string> = new Set(['project', 'thread', 'model']);

export const TRACKING_KEY = 'analytics_tracking_started_at';

/**
 * The instant recording began, stamped once and never moved.
 *
 * `bootAnalytics` (server.ts) calls this on every app start, BEFORE any route is
 * mounted, so the value is the instant the recorder began recording. The history
 * importer accepts only turns OLDER than this, so imported and live rows can
 * never describe the same turn — that boundary is what makes the import button
 * safe to press twice.
 *
 * Stamping it on first read instead would put the cutoff at "the first time
 * someone opened the Analytics view", and every turn measured live between boot
 * and that moment would be imported a second time.
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

  router.get('/backfill', (_req, res) => {
    // `backfilledTurns` is the ALL-TIME count, deliberately unfiltered: the panel's
    // remove control acts on the whole table, and the summary's range-scoped count
    // would hide it from a reader whose current range holds no imported rows.
    res.json({
      trackingStartedAt: trackingStartedAt(db),
      ...readBackfillState(db),
      backfilledTurns: usageDb.countBackfilled(db),
    });
  });

  // Manual, human-triggered import. Runs synchronously: a few hundred transcripts
  // parse in seconds, and a synchronous run cannot leave a half-written state
  // record behind if the daemon dies mid-import.
  router.post('/backfill', (_req, res) => {
    const cutoff = trackingStartedAt(db);
    const state = readBackfillState(db);
    if (state.state === 'running') { res.status(409).json({ error: 'an import is already running' }); return; }

    const threads: { terminalId: string; projectId: string; provider: string; role: string; transcriptPath: string }[] = [];
    for (const session of sessionsDb.list(db)) {
      for (const terminal of terminalsDb.listBySession(db, session.id)) {
        if (!terminal.external_id) continue;

        // Route by provider via the ONE shared map (history-import-strategy.ts):
        // Codex never writes under ~/.claude/projects, so the Claude-only
        // resolveTranscriptPath always returned undefined for it and every Codex
        // thread silently imported zero rows. A provider with no declared
        // strategy (or not an agent type at all — the plain shell) is skipped
        // rather than falling through to Claude's locator.
        const strategy = isAgentType(terminal.type) ? HISTORY_IMPORT_STRATEGY[terminal.type] : null;
        if (!strategy) continue;
        const workDir = terminal.working_dir || session.working_dir;
        const transcriptPath = strategy.locateTranscript(terminal, workDir);
        if (!transcriptPath) continue;
        let cfg: Record<string, any> = {};
        try { cfg = JSON.parse(terminal.config || '{}'); } catch { /* default {} */ }
        threads.push({
          terminalId: terminal.id, projectId: session.id, provider: terminal.type,
          role: typeof cfg.role === 'string' ? cfg.role : '', transcriptPath,
        });
      }
    }

    writeBackfillState(db, { state: 'running', done: 0, total: threads.length, lastFinishedAt: null });
    try {
      const result = importHistory(db, {
        cutoff, threads,
        onProgress: (done, total) => writeBackfillState(db, { state: 'running', done, total, lastFinishedAt: null }),
      });
      writeBackfillState(db, { state: 'done', done: threads.length, total: threads.length, lastFinishedAt: new Date().toISOString() });
      res.json(result);
    } catch (err: any) {
      writeBackfillState(db, { state: 'error', done: 0, total: threads.length, lastFinishedAt: null, error: String(err?.message ?? err) });
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  // Remove imported rows. Live measurements are never touched.
  router.delete('/backfill', (_req, res) => {
    const removed = usageDb.deleteBackfilled(db);
    writeBackfillState(db, { state: 'idle', done: 0, total: 0, lastFinishedAt: null });
    res.json({ removed });
  });

  return router;
}
