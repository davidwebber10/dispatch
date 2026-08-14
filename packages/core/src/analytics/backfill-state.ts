import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';

/**
 * Persisted progress/status of the manual history import. Lives in its own module
 * (rather than in routes/analytics.ts, where it originated) so that
 * analytics/importer.ts can read and clear a stale `running` state left behind
 * by a killed daemon without creating an import cycle between the router and the
 * importer.
 */
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
