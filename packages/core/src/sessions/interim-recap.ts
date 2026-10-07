/**
 * Interim recap after 20 minutes (structured-recap spec, Unit 5).
 *
 * Start: a Finished notice goes out while agents still work and no timer runs →
 *        `interimDueAt = now + 20 min` on the overseer's terminal config.
 * Stop:  a settled notice, or ledger_list({ forRecap: true }) (ledger-service.ts), clears it.
 * Check: a 60-second sweep (the auto-archive pattern). The due time lives in the database, so
 *        a daemon restart keeps it.
 * Fire:  at the due time, if the batch is busy (agents work or are queued — the Batch line's
 *        rule), one Interim recap notice. The timer clears only after the notice reached the
 *        overseer, or when the batch is no longer busy; a failed delivery stays due, and the
 *        next sweep retries. So it fires once per successful delivery.
 */
import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import { INTERIM_DUE_KEY } from '../overseer/ledger-service.js';
import { isBusy, type BatchState, type NoticeKind } from './batch-state.js';
import type { SessionService } from './service.js';

export const INTERIM_RECAP_MS = 20 * 60_000;
const DEFAULT_INTERVAL_MS = 60_000;

const agents = (n: number) => `${n} agent${n === 1 ? '' : 's'}`;

/**
 * The Interim recap notice. Its 🕒 prefix differs from every other notice prefix. The line
 * breaks after the first count ("and 2 agents" / "still work."), as in the spec text.
 */
export function formatInterimNotice(workingCount: number, queuedCount = 0): string {
  const queued = (n: number) => `${n === 1 ? 'is' : 'are'} queued`;
  let count: string;
  let rest: string;
  if (workingCount > 0) {
    count = agents(workingCount);
    rest = `still work${workingCount === 1 ? 's' : ''}`;
    if (queuedCount > 0) rest += ` and ${agents(queuedCount)} ${queued(queuedCount)}`;
  } else {
    count = agents(queuedCount);
    rest = queued(queuedCount);
  }
  return (
    `🕒 Interim recap due: agent turns finished ${INTERIM_RECAP_MS / 60_000} minutes ago, and ${count}\n` +
    `${rest}. Post the recap now and mark it "interim". Then keep holding.`
  );
}

/** Remove the due time from a coordinator's CURRENT config (re-read, so nothing else is lost). */
function clearDue(db: Database.Database, terminalId: string): void {
  const row = terminalsDb.getById(db, terminalId);
  if (!row) return;
  const cfg = terminalsDb.rowToTerminal(row).config;
  if (!(INTERIM_DUE_KEY in cfg)) return;
  const next = { ...cfg };
  delete next[INTERIM_DUE_KEY];
  terminalsDb.updateConfig(db, terminalId, next);
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
      const state: BatchState = sessionService.batchState(row.session_id);
      if (!isBusy(state)) { clearDue(db, row.id); continue; } // settled: nothing to report
      if (sessionService.sendInterimRecapNotice(row.id, state.working.length, state.queued.length)) {
        clearDue(db, row.id); // delivered: it fires once
        fired.push(row.id);
      } else {
        console.error(`interim recap: delivery to ${row.id} failed; the next sweep retries`);
      }
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
