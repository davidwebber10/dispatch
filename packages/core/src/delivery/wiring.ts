/**
 * The daemon wiring of the delivery outbox (engineering program W2-C). Both composition roots of
 * server.ts (createApp, startServer) call these, so the two cannot drift.
 */
import type Database from 'better-sqlite3';
import type { SessionService } from '../sessions/service.js';
import type { StatusService } from '../status/service.js';
import { DeliveryOutbox, type DeliverResult } from './outbox.js';

/** Delivered and dropped rows are kept this long (for the diagnostics view and the dedup keys), then removed at a boot. */
export const OUTBOX_KEEP_MS = 7 * 24 * 3600_000;

/**
 * Builds the outbox and gives it to SessionService (its notices go through it). A watch wake is
 * delivered by `watchDeliver` (server.ts buildWatchDeliver); every other kind by
 * SessionService.deliverOutboxRow.
 */
export function createDeliveryOutbox(
  db: Database.Database,
  sessionService: SessionService,
  watchDeliver: (terminalId: string, text: string) => DeliverResult | void,
): DeliveryOutbox {
  const outbox = new DeliveryOutbox({
    db,
    deliver: (targetId, body, kind) => (kind === 'watch' ? watchDeliver(targetId, body) ?? 'delivered' : sessionService.deliverOutboxRow(targetId, body, kind)),
  });
  sessionService.setDeliveryOutbox(outbox);
  return outbox;
}

/**
 * The retry events. A pending row is tried again when its target's process started (the first
 * harness event of a new process) and when its target's turn settled. No timer: a row for a
 * thread that does nothing waits until that thread does something.
 */
export function subscribeDeliveryOutbox(outbox: DeliveryOutbox, statusService: StatusService): void {
  statusService.onHarnessCommitted((event) => { if (event.type === 'process.started') outbox.flush(event.terminalId); });
  statusService.addThreadSettledListener(({ terminalId }) => { outbox.flush(terminalId); });
}

/** The third retry event: once at boot, after the kickstart. Also removes old finished rows. */
export function flushOutboxAtBoot(outbox: DeliveryOutbox): { delivered: number; pruned: number } {
  let pruned = 0;
  try { pruned = outbox.prune(OUTBOX_KEEP_MS); } catch (err) { console.warn('[outbox] prune failed', err instanceof Error ? err.message : String(err)); }
  return { delivered: outbox.flushAll(), pruned };
}
