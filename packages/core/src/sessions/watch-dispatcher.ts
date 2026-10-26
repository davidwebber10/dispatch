import { stripControlChars } from './pty-message.js';
import type Database from 'better-sqlite3';
import * as watchesDb from '../db/watches.js';
import * as terminalsDb from '../db/terminals.js';

export type DeliverFn = (terminalId: string, text: string) => void;

/** The only statuses a watch can react to: the peer finished, asked, or failed.
 *  'working'/'scheduled'/'done' edges are not wake-worthy — waking on 'working'
 *  would burn a one-shot watch at turn START, before there's anything to see. */
export const WATCHABLE_STATUSES = ['idle', 'needs_input', 'error'] as const;

/** Terminal row status -> the watchable status it was entered through ('waiting' covers idle/done). */
const SETTLED_STATUS: Record<string, (typeof WATCHABLE_STATUSES)[number]> = {
  waiting: 'idle',
  needs_input: 'needs_input',
  error: 'error',
};

/** lifecycle_events types that settle a thread / change its state otherwise (see StatusService). */
const SETTLING = ['turn.completed', 'turn.failed', 'permission.requested', 'status.idle', 'status.needs_input', 'status.error', 'status.waiting'];
const OTHER_STATE = ['turn.started', 'permission.resolved', 'process.started', 'process.exited', 'status.working', 'status.starting', 'status.done', 'status.scheduled', 'status.queued'];
const quoted = (xs: string[]) => xs.map((x) => `'${x}'`).join(',');
const SETTLING_SQL = quoted(SETTLING);
const OTHER_STATE_SQL = quoted(OTHER_STATE);

/**
 * Fires `thread_watches` subscriptions off the status machine. Wired into StatusService as
 * an optional injected dependency (see status/service.ts's `onWatchStatus`, which mirrors the
 * pre-existing `onActivity` callback shape) so a status edge both stamps activity AND wakes
 * any peer watching this terminal for that criteria — see server.ts for the wiring and the
 * `deliver` function that picks structured vs PTY transport per target.
 */
export class WatchDispatcher {
  constructor(
    private db: Database.Database,
    private deliver: DeliverFn,
    private opts: { now?: () => number } = {},
  ) {}

  /**
   * Called on every (non-`starting`) status edge for `targetTerminalId`. Finds live watches
   * whose criteria matches `status` (or is 'any'), delivers a wake message to each live
   * watcher, and marks the watch fired (one-shot rows then drop out of future matches;
   * repeating rows stay live). A watcher whose terminal row is gone or archived has its
   * watch dropped instead of delivered to. Never throws — a wake failure must never break
   * status recording.
   */
  onStatus(targetTerminalId: string, status: string): void {
    // Only notable statuses can wake a watch; non-notable edges (like 'working')
    // are never wake-worthy and could never match any criteria anyway.
    if (!WATCHABLE_STATUSES.includes(status as any)) {
      return;
    }
    const target = terminalsDb.getById(this.db, targetTerminalId);
    if (!target) return; // nothing to report on
    const matches = watchesDb.liveForTarget(this.db, targetTerminalId, status);
    for (const watch of matches) {
      this.fire(watch, target, status);
    }
  }

  /**
   * Called right after a watch is created. A watch only reacts to status EDGES, so one
   * registered after the target already settled would wait forever (2026-10-26: a worker
   * blocked ~6 min in a foreground command, its reviewer went idle meanwhile, and the
   * watch_thread call that followed never fired). If the target is now sitting in a state
   * the watch matches AND settled during the watcher's current turn, the watch is spent
   * here and the wake text is RETURNED (not delivered): the caller is mid-turn inside the
   * very tool call that created the watch, so a second queued delivery would make it act
   * twice. A target that settled before the watcher's turn began does not count: that is
   * the old turn's result, and the watcher is waiting for the next one (message_thread,
   * then watch_thread). Returns the wake text, or null when nothing fired.
   */
  catchUp(watchId: string): string | null {
    try {
      const watch = watchesDb.getById(this.db, watchId);
      if (!watch) return null;
      const target = terminalsDb.getById(this.db, watch.target_terminal_id);
      const watcher = terminalsDb.getById(this.db, watch.watcher_terminal_id);
      if (!target || !watcher || watcher.archived_at) return null;
      const status = SETTLED_STATUS[target.status];
      if (!status || (watch.criteria !== 'any' && watch.criteria !== status)) return null;
      const turnStart = this.currentTurnStart(watcher);
      const settledAt = this.settledAt(target.id);
      if (!turnStart || !settledAt || settledAt < turnStart) return null;
      const text = composeWakeMessage({ id: target.id, label: target.label }, status, watch.note);
      watchesDb.markFired(this.db, watch.id);
      return text;
    } catch (err) {
      console.debug('[watch-dispatcher] catch-up failed', watchId, err);
      return null;
    }
  }

  /** When the watcher's current turn began: the open usage_turns row (stable for the whole turn;
   *  thread_lifecycle.observed_at is not: every tool hook and mid-turn message moves it, so it is
   *  only the fallback for a thread with no open row), pushed forward to the first working event after the
   *  watcher's own last settle, because an interrupted CLI turn (Esc sends no Stop) leaves its old row open.
   *  null when the watcher is not working. */
  private currentTurnStart(watcher: terminalsDb.TerminalRow): string | null {
    if (watcher.status !== 'working') return null;
    const turn = this.db.prepare('SELECT started_at FROM usage_turns WHERE terminal_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1')
      .get(watcher.id) as { started_at: string } | undefined;
    let start: string | null = turn?.started_at ?? null;
    if (!start) {
      const lifecycle = this.db.prepare('SELECT observed_at FROM thread_lifecycle WHERE terminal_id = ?')
        .get(watcher.id) as { observed_at: string } | undefined;
      start = lifecycle?.observed_at ?? watcher.last_activity_at;
    }
    // A stale open row (interrupted turn): the real turn began at the first working event after the watcher's last settle.
    const lastSettle = this.db.prepare(`SELECT MAX(id) AS id FROM lifecycle_events
      WHERE terminal_id = ? AND disposition IN ('applied','inferred') AND event_type IN (${SETTLING_SQL})`)
      .get(watcher.id) as { id: number | null };
    if (lastSettle.id === null) return start;
    const began = this.db.prepare(`SELECT MIN(observed_at) AS at FROM lifecycle_events
      WHERE terminal_id = ? AND disposition IN ('applied','inferred') AND event_type IN ('turn.started','status.working') AND id > ?`)
      .get(watcher.id, lastSettle.id) as { at: string | null };
    return began.at && (!start || began.at > start) ? began.at : start;
  }

  /** When the target entered the settled state it is in now: the FIRST settling event after the
   *  last non-settling state event (a working/resume/exit/start). null if the latest state event is
   *  not a settle (e.g. permission, resume, then a clean exit). NOT last_activity_at, which the PTY
   *  monitor also stamps after an output burst with no status change; the first event, not the
   *  latest, because Claude sends a second idle notification ~60 s after Stop. */
  private settledAt(targetId: string): string | null {
    const lastOther = this.db.prepare(`SELECT MAX(id) AS id FROM lifecycle_events
      WHERE terminal_id = ? AND disposition IN ('applied','inferred') AND event_type IN (${OTHER_STATE_SQL})`)
      .get(targetId) as { id: number | null };
    const row = this.db.prepare(`SELECT MIN(observed_at) AS at FROM lifecycle_events
      WHERE terminal_id = ? AND disposition IN ('applied','inferred') AND event_type IN (${SETTLING_SQL}) AND id > ?`)
      .get(targetId, lastOther.id ?? 0) as { at: string | null };
    return row.at;
  }

  private fire(watch: watchesDb.WatchRow, target: terminalsDb.TerminalRow, status: string): void {
    const watcher = terminalsDb.getById(this.db, watch.watcher_terminal_id);
    if (!watcher || watcher.archived_at) {
      // Dead or archived watcher: drop the subscription silently rather than deliver to it.
      watchesDb.remove(this.db, watch.id);
      return;
    }
    try {
      const text = composeWakeMessage({ id: target.id, label: target.label }, status, watch.note);
      this.deliver(watch.watcher_terminal_id, text);
    } catch (err) {
      // A wake failure (dead transport, network hiccup, whatever) must never break status
      // recording — swallow and move on. The watch still fires below.
      console.debug('[watch-dispatcher] delivery failed', watch.id, err);
    }
    watchesDb.markFired(this.db, watch.id);
  }
}

/**
 * Composes the wake message delivered to a watcher: names the target's label and id, says
 * what happened, echoes the watcher's own note verbatim (when present), and points at
 * `read_thread`. Example: `Thread "Fix login bug" (t_abc123) just went idle. You asked to
 * watch it: "review its diff". Use read_thread to see what it did.`
 */
/** What each watchable status means in plain language, and what the woken watcher
 *  should do next. Raw status names ("just went needs_input") read as machine noise,
 *  and "see what it did" is wrong when the peer is actually asking a question — the
 *  watcher acts on this text, so it says what happened and what to do about it. */
const STATUS_PHRASING: Record<string, { happened: string; next: string }> = {
  idle: { happened: 'finished its turn', next: 'Use read_thread to see what it did.' },
  needs_input: {
    happened: 'is waiting on a question',
    next: 'Use read_thread to see what it asked; answer_agent or message_thread can reply.',
  },
  error: { happened: 'hit an error', next: 'Use read_thread to see what went wrong.' },
};

export function composeWakeMessage(target: { id: string; label: string }, status: string, note: string | null): string {
  const phrasing = STATUS_PHRASING[status] ?? { happened: `changed status to ${status}`, next: 'Use read_thread for detail.' };
  // The note and the label are free text that ends up typed into a terminal: one line, no controls.
  const oneLine = (t: string) => stripControlChars(t, { keepNewline: false });
  const askedClause = note ? ` You asked to watch it: "${oneLine(note)}".` : '';
  return `Thread "${oneLine(target.label)}" (${target.id}) ${phrasing.happened}.${askedClause} ${phrasing.next}`;
}
