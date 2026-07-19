import type Database from 'better-sqlite3';
import * as watchesDb from '../db/watches.js';
import * as terminalsDb from '../db/terminals.js';

export type DeliverFn = (terminalId: string, text: string) => void;

/** The only statuses a watch can react to: the peer finished, asked, or failed.
 *  'working'/'scheduled'/'done' edges are not wake-worthy — waking on 'working'
 *  would burn a one-shot watch at turn START, before there's anything to see. */
export const WATCHABLE_STATUSES = ['idle', 'needs_input', 'error'] as const;

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
export function composeWakeMessage(target: { id: string; label: string }, status: string, note: string | null): string {
  const askedClause = note ? ` You asked to watch it: "${note}".` : '';
  return `Thread "${target.label}" (${target.id}) just went ${status}.${askedClause} Use read_thread to see what it did.`;
}
