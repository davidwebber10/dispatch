import fs from 'fs';
import type Database from 'better-sqlite3';
import * as usageDb from '../db/usage.js';
import { readBackfillState, writeBackfillState } from './backfill-state.js';
import { HISTORY_IMPORT_STRATEGY, type ImportThread } from './history-import-strategy.js';
import { isAgentType } from '../providers/agent-types.js';

export type { ImportThread } from './history-import-strategy.js';

export interface ImportResult {
  imported: number;
  skipped: number;
  threads: number;
}

/**
 * The manual, one-off history import. It runs ONLY when the human presses the
 * button — never on daemon start, and never on a timer.
 *
 * Two properties make it safe to press twice:
 *   1. It writes only turns strictly OLDER than `cutoff`
 *      (app_state's analytics_tracking_started_at). Live recording owns everything
 *      from that instant on, so the two can never describe the same turn.
 *   2. Every row it writes carries backfilled = 1, and a run deletes those rows
 *      first. A live row is never touched, so a failed import cannot damage a
 *      real measurement.
 *
 * One imported assistant message (Claude) or one `token_count` diff (Codex)
 * becomes one turn row. A transcript records no turn boundaries, so `ended_at`
 * equals `started_at` and the row contributes no duration — the duration
 * queries exclude `ended_at == started_at` for exactly this reason.
 */
export function importHistory(
  db: Database.Database,
  opts: { cutoff: string; threads: ImportThread[]; onProgress?: (done: number, total: number) => void },
): ImportResult {
  usageDb.deleteBackfilled(db);

  let imported = 0;
  let skipped = 0;
  let threads = 0;
  let done = 0;

  for (const t of opts.threads) {
    done += 1;
    opts.onProgress?.(done, opts.threads.length);

    let raw: string;
    try { raw = fs.readFileSync(t.transcriptPath, 'utf-8'); }
    catch { continue; } // a missing transcript is normal: PTY threads have none

    // Declared in ONE place (history-import-strategy.ts), keyed off AGENT_TYPES.
    // A provider with no strategy (or not an agent type at all) is skipped rather
    // than defaulting to Claude's line parser — the old `t.provider === 'codex' ?
    // codex : claude` ternary silently ran every future provider's lines through
    // the Claude parser, which is exactly the bug this map exists to prevent.
    const strategy = isAgentType(t.provider) ? HISTORY_IMPORT_STRATEGY[t.provider] : null;
    if (!strategy) continue;
    const result = strategy.importLines(db, t, raw, opts.cutoff);

    imported += result.imported;
    skipped += result.skipped;
    if (result.imported > 0) threads += 1;
  }

  return { imported, skipped, threads };
}

/**
 * Clear a persisted `running` import state left behind by a daemon that died
 * mid-import. The import is synchronous and in-process, so a `running` state that
 * survives a restart describes a process that no longer exists — it can only ever
 * be stale. Without this, the POST guard's 409 would block the import button
 * forever, and the only escape would be a DELETE the UI has no reason to offer.
 *
 * Mirrors closeInterruptedTurns: a restart makes the leftover state a lie, so the
 * boot path corrects it rather than leaving a user stuck.
 */
export function clearStaleImportState(db: Database.Database): boolean {
  try {
    const state = readBackfillState(db);
    if (state.state !== 'running') return false;
    writeBackfillState(db, { state: 'error', done: state.done, total: state.total, lastFinishedAt: null, error: 'interrupted by a restart' });
    return true;
  } catch {
    return false;
  }
}
