/**
 * Interim recap after 20 minutes (structured-recap spec, Unit 5).
 *
 * Start: a Finished notice goes out while agents still work and no timer runs →
 *        `interimDueAt = now + 20 min` on the overseer's terminal config.
 * Stop:  a settled notice, or ledger_list({ forRecap: true }) (ledger-service.ts), clears it.
 * Check: a 60-second sweep (the auto-archive pattern). The due time lives in the database, so
 *        a daemon restart keeps it.
 * Fire:  at the due time, if agents still work, one Interim recap notice; the timer clears
 *        either way, so it fires once.
 */
import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import { INTERIM_DUE_KEY } from '../overseer/ledger-service.js';
import type { BatchState, NoticeKind } from './batch-state.js';
import type { SessionService } from './service.js';

export const INTERIM_RECAP_MS = 20 * 60_000;
const DEFAULT_INTERVAL_MS = 60_000;

/** The Interim recap notice. Its 🕒 prefix differs from every other notice prefix. */
export function formatInterimNotice(workingCount: number): string {
  const n = workingCount;
  return (
    `🕒 Interim recap due: agent turns finished ${INTERIM_RECAP_MS / 60_000} minutes ago, and ${n} agent${n === 1 ? '' : 's'}\n` +
    `still work${n === 1 ? 's' : ''}. Post the recap now and mark it "interim". Then keep holding.`
  );
}

/**
 * The overseer config after a notice, or null when it does not change. Pure.
 *  - settled (not busy)                         → clear the timer
 *  - busy Finished notice with no timer running → arm it at now + 20 min
 *  - anything else                              → unchanged
 */
export function nextInterimConfig(
  config: Record<string, any>,
  notice: { kind: NoticeKind; busy: boolean; now: number },
): Record<string, any> | null {
  const armed = typeof config[INTERIM_DUE_KEY] === 'string';
  if (!notice.busy) {
    if (!armed) return null;
    const next = { ...config };
    delete next[INTERIM_DUE_KEY];
    return next;
  }
  if (notice.kind === 'finished' && !armed) {
    return { ...config, [INTERIM_DUE_KEY]: new Date(notice.now + INTERIM_RECAP_MS).toISOString() };
  }
  return null;
}

/** One sweep pass (exported for tests — no timers involved). Returns the overseers it notified. */
export function interimRecapTick(
  db: Database.Database,
  sessionService: Pick<SessionService, 'batchState' | 'sendInterimRecapNotice'>,
  now: number = Date.now(),
): string[] {
  const fired: string[] = [];
  let rows: terminalsDb.TerminalRow[];
  try {
    rows = db.prepare('SELECT * FROM terminals WHERE archived_at IS NULL').all() as terminalsDb.TerminalRow[];
  } catch (err) {
    console.error('interim recap: sweep query failed (DB may be closing)', err);
    return fired;
  }
  for (const row of rows) {
    try {
      const cfg = terminalsDb.rowToTerminal(row).config;
      if (cfg.role !== 'coordinator' || typeof cfg[INTERIM_DUE_KEY] !== 'string') continue;
      const due = Date.parse(cfg[INTERIM_DUE_KEY]);
      if (Number.isFinite(due) && now < due) continue;
      // Clear first: the timer fires once, even if the send below fails.
      const next = { ...cfg };
      delete next[INTERIM_DUE_KEY];
      terminalsDb.updateConfig(db, row.id, next);
      const state: BatchState = sessionService.batchState(row.session_id);
      if (state.working.length > 0 && sessionService.sendInterimRecapNotice(row.id, state.working.length)) fired.push(row.id);
    } catch (err) {
      console.error(`interim recap: failed for terminal ${row.id}`, err);
    }
  }
  return fired;
}

/** Start the sweep loop. Returns the interval id for cleanup. */
export function startInterimRecapLoop(
  db: Database.Database,
  sessionService: SessionService,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): NodeJS.Timeout {
  return setInterval(() => {
    try {
      interimRecapTick(db, sessionService);
    } catch (err) {
      console.error('interim recap sweep failed', err);
    }
  }, intervalMs);
}
