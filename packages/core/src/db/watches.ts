import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';

export interface WatchRow {
  id: string;
  watcher_terminal_id: string;
  target_terminal_id: string;
  criteria: 'idle' | 'needs_input' | 'error' | 'any';
  note: string | null;
  once: number;
  created_at: string;
  fired_at: string | null;
}

interface CreateInput {
  watcherTerminalId: string;
  targetTerminalId: string;
  criteria: WatchRow['criteria'];
  note?: string | null;
  once?: boolean;
}

// A watch is "live" once created until either it's removed, or it was a
// one-shot (once = 1) and has fired. Repeating watches (once = 0) stay live
// forever, re-matching on every subsequent qualifying status edge.
const LIVE_CLAUSE = '(fired_at IS NULL OR once = 0)';

export function create(db: Database.Database, input: CreateInput): string {
  const id = uuid();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO thread_watches (id, watcher_terminal_id, target_terminal_id, criteria, note, once, created_at, fired_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    id,
    input.watcherTerminalId,
    input.targetTerminalId,
    input.criteria,
    input.note ?? null,
    // One-shot is the DEFAULT (spec): "watch X until it finishes" must not re-fire on
    // every later idle of X. Only an explicit `once: false` makes a watch repeating.
    input.once === false ? 0 : 1,
    now,
  );
  return id;
}

/** Live watches owned by this watcher. */
export function listByWatcher(db: Database.Database, watcherTerminalId: string): WatchRow[] {
  return db.prepare(`SELECT * FROM thread_watches WHERE watcher_terminal_id = ? AND ${LIVE_CLAUSE} ORDER BY created_at ASC`)
    .all(watcherTerminalId) as WatchRow[];
}

/** Live watches aimed at this target. */
export function listByTarget(db: Database.Database, targetTerminalId: string): WatchRow[] {
  return db.prepare(`SELECT * FROM thread_watches WHERE target_terminal_id = ? AND ${LIVE_CLAUSE} ORDER BY created_at ASC`)
    .all(targetTerminalId) as WatchRow[];
}

/** Live watches on this target whose criteria matches `status` exactly, or is 'any'. */
export function liveForTarget(db: Database.Database, targetTerminalId: string, status: string): WatchRow[] {
  return db.prepare(`
    SELECT * FROM thread_watches
    WHERE target_terminal_id = ? AND ${LIVE_CLAUSE} AND (criteria = ? OR criteria = 'any')
    ORDER BY created_at ASC
  `).all(targetTerminalId, status) as WatchRow[];
}

/** Stamps fired_at. A once=1 row then drops out of every live query above; a once=0 row stays live. */
export function markFired(db: Database.Database, id: string): void {
  db.prepare('UPDATE thread_watches SET fired_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

export function remove(db: Database.Database, id: string): boolean {
  const r = db.prepare('DELETE FROM thread_watches WHERE id = ?').run(id);
  return r.changes > 0;
}

/** Deletes every watch where `terminalId` is either the watcher or the target — used when a thread is deleted. */
export function removeForTerminal(db: Database.Database, terminalId: string): void {
  db.prepare('DELETE FROM thread_watches WHERE watcher_terminal_id = ? OR target_terminal_id = ?')
    .run(terminalId, terminalId);
}

/** Count of live watches owned by this watcher (used for fan-out caps). */
export function countByWatcher(db: Database.Database, watcherTerminalId: string): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM thread_watches WHERE watcher_terminal_id = ? AND ${LIVE_CLAUSE}`)
    .get(watcherTerminalId) as { count: number };
  return row.count;
}
