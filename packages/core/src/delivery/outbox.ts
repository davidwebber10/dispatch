/**
 * The delivery outbox (engineering program W2-C).
 *
 * A message for a thread (a worker's notice to its starter, a watch wake, a lost-wake notice) is
 * written to `delivery_outbox` first, then delivered. If the target cannot take it now, the row
 * stays `pending` and is tried again on an EVENT of that target: its process started, its turn
 * settled, or the daemon booted. There is no timer and no polling loop in this file.
 *
 * A message is delivered at least once: a daemon that dies between the delivery and the write of
 * `delivered` sends it again after the restart. `dedup_key` stops the same event from making two rows.
 */
import type Database from 'better-sqlite3';
import * as outboxDb from '../db/outbox.js';
import type { OutboxKind, OutboxRow, OutboxState } from '../db/outbox.js';

export type { OutboxKind, OutboxRow, OutboxState } from '../db/outbox.js';

/**
 * What the deliver function answers. `not-alive`: the target is not running; the row waits (this is
 * not a failed attempt). `gone`: the target is archived or removed; the row is dropped. A throw is
 * a failed attempt.
 */
export type DeliverResult = 'delivered' | 'not-alive' | 'gone';

export interface DeliveryOutboxDeps {
  db: Database.Database;
  deliver(targetId: string, body: string, kind: OutboxKind): DeliverResult;
  now?: () => number;
  /** A row is dropped when this many attempts threw. Default 5. */
  maxAttempts?: number;
}

export interface EnqueueInput {
  targetId: string;
  sourceId?: string;
  kind: OutboxKind;
  body: string;
  dedupKey: string;
  /**
   * The message is only useful now (a worker's question that goes to the user when its starter
   * cannot take it). If the same call does not deliver the row, the row is dropped with this reason.
   */
  immediateOnly?: string;
}

export const GONE_REASON = 'the target is archived or removed';
const NOT_ALIVE_REASON = 'the target is not running';
/** One flush makes at most this many passes over a target (a pass repeats only if a row arrived during it). */
const MAX_PASSES = 4;

export class DeliveryOutbox {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private deliveredListeners: ((row: OutboxRow) => void)[] = [];
  private droppedListeners: ((row: OutboxRow) => void)[] = [];
  /** Targets with a delivery in progress. A delivery can start the target, and that start flushes the same target. */
  private busy = new Set<string>();
  /** Targets that got a flush request or a new row during their own delivery. */
  private again = new Set<string>();

  constructor(private deps: DeliveryOutboxDeps) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
    this.maxAttempts = deps.maxAttempts ?? 5;
  }

  private iso(): string { return new Date(this.now()).toISOString(); }

  /** Writes the row, then tries the pending rows of the target (oldest first) in the same call. */
  enqueue(input: EnqueueInput): { id: number; state: OutboxState; duplicate: boolean } {
    const { row, duplicate } = outboxDb.insert(this.db, input, this.iso());
    if (duplicate) return { id: row.id, state: row.state, duplicate: true };
    this.run(input.targetId);
    let state = outboxDb.getById(this.db, row.id)?.state ?? row.state;
    if (state === 'pending' && input.immediateOnly && this.dropRow(row.id, input.immediateOnly)) state = 'dropped';
    return { id: row.id, state, duplicate: false };
  }

  /** Tries each pending row of the target, oldest first. Returns the number delivered. */
  flush(targetId: string): number {
    return this.run(targetId);
  }

  /** Tries the pending rows of every target (the boot flush). Returns the number delivered. */
  flushAll(): number {
    if (!this.db.open) return 0; // a daemon that stops during its own boot has closed the database
    let n = 0;
    for (const targetId of outboxDb.pendingTargets(this.db)) n += this.run(targetId);
    return n;
  }

  /** Drops every pending row of the target (it was archived or removed). Returns the number dropped. */
  drop(targetId: string, reason: string): number {
    let n = 0;
    for (const row of outboxDb.pendingForTarget(this.db, targetId)) if (this.dropRow(row.id, reason)) n++;
    return n;
  }

  list(filter: { terminalId?: string; state?: OutboxState; limit?: number } = {}): OutboxRow[] {
    return outboxDb.list(this.db, filter);
  }

  /** Removes delivered and dropped rows older than `olderThanMs`. Called at boot, never on a timer. */
  prune(olderThanMs: number): number {
    if (!this.db.open) return 0;
    return outboxDb.prune(this.db, new Date(this.now() - olderThanMs).toISOString());
  }

  onDelivered(fn: (row: OutboxRow) => void): void { this.deliveredListeners.push(fn); }
  /** A row that will never be delivered: the target is gone, or the attempts ran out. */
  onDropped(fn: (row: OutboxRow) => void): void { this.droppedListeners.push(fn); }

  private run(targetId: string): number {
    if (!this.db.open) return 0;
    if (this.busy.has(targetId)) { this.again.add(targetId); return 0; }
    this.busy.add(targetId);
    let delivered = 0;
    try {
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        this.again.delete(targetId);
        for (const row of outboxDb.pendingForTarget(this.db, targetId)) {
          const result = this.attempt(row);
          if (result === 'delivered') delivered++;
          // The target cannot take a message now: a later row would fail too, or overtake this one.
          else if (result === 'waiting' || result === 'failed') break;
        }
        if (!this.again.has(targetId)) break;
      }
    } catch (err) {
      console.warn('[outbox] flush failed', targetId, err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.delete(targetId);
      this.again.delete(targetId);
    }
    return delivered;
  }

  private attempt(row: OutboxRow): 'delivered' | 'waiting' | 'failed' | 'dropped' {
    let result: DeliverResult;
    try {
      result = this.deps.deliver(row.target_terminal_id, row.body, row.kind);
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      const attempts = outboxDb.recordFailure(this.db, row.id, message);
      if (attempts >= this.maxAttempts) {
        this.dropRow(row.id, message);
        console.warn(`[outbox] dropped ${row.kind} ${row.id} for ${row.target_terminal_id} after ${attempts} failed attempts: ${message}`);
        return 'dropped';
      }
      return 'failed';
    }
    if (result === 'delivered') {
      if (outboxDb.markDelivered(this.db, row.id, this.iso())) this.emit(this.deliveredListeners, row.id);
      return 'delivered';
    }
    if (result === 'gone') {
      this.dropRow(row.id, GONE_REASON);
      return 'dropped';
    }
    outboxDb.recordWaiting(this.db, row.id, NOT_ALIVE_REASON);
    return 'waiting';
  }

  private dropRow(id: number, reason: string): boolean {
    if (!outboxDb.markDropped(this.db, id, reason)) return false;
    this.emit(this.droppedListeners, id);
    return true;
  }

  private emit(listeners: ((row: OutboxRow) => void)[], id: number): void {
    const row = outboxDb.getById(this.db, id);
    if (!row) return;
    for (const fn of listeners) {
      try { fn(row); } catch (err) { console.warn('[outbox] listener failed', err instanceof Error ? err.message : String(err)); }
    }
  }
}
