import type Database from 'better-sqlite3';

/** What a row carries. `kickstart` is reserved for the boot kickstart (not written in this wave). */
export type OutboxKind = 'notice' | 'watch' | 'kickstart' | 'question' | 'lost-wake';
export type OutboxState = 'pending' | 'delivered' | 'dropped';

export interface OutboxRow {
  id: number;
  target_terminal_id: string;
  source_terminal_id: string | null;
  kind: OutboxKind;
  body: string;
  dedup_key: string;
  state: OutboxState;
  attempts: number;
  /** The last failure, the reason a row waits, or the reason it was dropped. */
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
}

export interface InsertInput {
  targetId: string;
  sourceId?: string | null;
  kind: OutboxKind;
  body: string;
  dedupKey: string;
}

/** Writes the row as `pending`. One dedup key makes one row: a second insert returns the first row. */
export function insert(db: Database.Database, input: InsertInput, nowIso: string): { row: OutboxRow; duplicate: boolean } {
  const r = db.prepare(`INSERT OR IGNORE INTO delivery_outbox
    (target_terminal_id, source_terminal_id, kind, body, dedup_key, state, attempts, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`)
    .run(input.targetId, input.sourceId ?? null, input.kind, input.body, input.dedupKey, nowIso);
  const row = db.prepare('SELECT * FROM delivery_outbox WHERE dedup_key = ?').get(input.dedupKey) as OutboxRow;
  return { row, duplicate: r.changes === 0 };
}

export function getById(db: Database.Database, id: number): OutboxRow | undefined {
  return db.prepare('SELECT * FROM delivery_outbox WHERE id = ?').get(id) as OutboxRow | undefined;
}

/** The pending rows of one target, oldest first. */
export function pendingForTarget(db: Database.Database, targetId: string): OutboxRow[] {
  return db.prepare("SELECT * FROM delivery_outbox WHERE target_terminal_id = ? AND state = 'pending' ORDER BY id ASC").all(targetId) as OutboxRow[];
}

/** Every target that has a pending row, in the order of its oldest row. */
export function pendingTargets(db: Database.Database): string[] {
  return (db.prepare("SELECT target_terminal_id AS id FROM delivery_outbox WHERE state = 'pending' GROUP BY target_terminal_id ORDER BY MIN(id) ASC").all() as { id: string }[])
    .map((r) => r.id);
}

/** Only a pending row changes state: a second writer finds 0 changes. */
export function markDelivered(db: Database.Database, id: number, nowIso: string): boolean {
  return db.prepare("UPDATE delivery_outbox SET state = 'delivered', delivered_at = ?, last_error = NULL WHERE id = ? AND state = 'pending'").run(nowIso, id).changes === 1;
}

export function markDropped(db: Database.Database, id: number, reason: string): boolean {
  return db.prepare("UPDATE delivery_outbox SET state = 'dropped', last_error = ? WHERE id = ? AND state = 'pending'").run(reason, id).changes === 1;
}

/** A failed attempt (the deliver function threw). Returns the new count. */
export function recordFailure(db: Database.Database, id: number, error: string): number {
  db.prepare("UPDATE delivery_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ? AND state = 'pending'").run(error, id);
  return getById(db, id)?.attempts ?? 0;
}

/** The row waits (the target is not running). Not an attempt. */
export function recordWaiting(db: Database.Database, id: number, reason: string): void {
  db.prepare("UPDATE delivery_outbox SET last_error = ? WHERE id = ? AND state = 'pending'").run(reason, id);
}

/** Newest first. */
export function list(db: Database.Database, filter: { terminalId?: string; state?: OutboxState; limit?: number } = {}): OutboxRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.terminalId) { where.push('target_terminal_id = ?'); args.push(filter.terminalId); }
  if (filter.state) { where.push('state = ?'); args.push(filter.state); }
  const limit = Math.max(1, Math.min(1000, Math.floor(filter.limit ?? 200)));
  return db.prepare(`SELECT * FROM delivery_outbox ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${limit}`).all(...args) as OutboxRow[];
}

/** Removes delivered and dropped rows made before `beforeIso`. A pending row is never removed here. */
export function prune(db: Database.Database, beforeIso: string): number {
  return db.prepare("DELETE FROM delivery_outbox WHERE state != 'pending' AND created_at < ?").run(beforeIso).changes;
}

/** Removes every row addressed to a thread that was deleted. */
export function removeForTarget(db: Database.Database, targetId: string): number {
  return db.prepare('DELETE FROM delivery_outbox WHERE target_terminal_id = ?').run(targetId).changes;
}
