import type Database from 'better-sqlite3';

// Terminal types that have PTY processes
export type TerminalType = 'claude-code' | 'codex' | 'shell';
// All tab types (terminals + non-PTY tabs)
export type TabType = TerminalType | 'browser' | 'notes';

export const PTY_TYPES: readonly string[] = ['claude-code', 'codex', 'shell'];

export function isPtyType(type: string): type is TerminalType {
  return PTY_TYPES.includes(type);
}

export interface TerminalRow {
  id: string;
  session_id: string;
  type: string;
  label: string;
  pid: number | null;
  external_id: string | null;
  skip_permissions: number;
  working_dir: string | null;
  status: string;
  created_at: string;
  last_activity_at: string | null;
  config: string | null;
  archived_at: string | null;
  sort_order: number;
}

export interface Terminal {
  id: string;
  sessionId: string;
  type: string;
  label: string;
  pid: number | null;
  externalId: string | null;
  skipPermissions: boolean;
  workingDir: string | null;
  status: string;
  createdAt: string;
  lastActivityAt: string;
  config: Record<string, any>;
  archivedAt: string | null;
  sortOrder: number;
}

export function rowToTerminal(row: TerminalRow): Terminal {
  let config: Record<string, any> = {};
  try { config = JSON.parse(row.config || '{}'); } catch {}
  return {
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
    label: row.label,
    pid: row.pid,
    externalId: row.external_id,
    skipPermissions: !!row.skip_permissions,
    workingDir: row.working_dir,
    status: row.status || 'waiting',
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at ?? row.created_at,
    config,
    archivedAt: row.archived_at,
    sortOrder: row.sort_order ?? 0,
  };
}

interface CreateInput {
  id: string;
  sessionId: string;
  type: string;
  label: string;
  externalId?: string;
  skipPermissions?: boolean;
  workingDir?: string;
  config?: Record<string, any>;
}

export function create(db: Database.Database, input: CreateInput): string {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO terminals (id, session_id, type, label, external_id, skip_permissions, working_dir, config, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id, input.sessionId, input.type, input.label,
    input.externalId ?? null, input.skipPermissions ? 1 : 0,
    input.workingDir ?? null, JSON.stringify(input.config ?? {}), now
  );
  return input.id;
}

export function getById(db: Database.Database, id: string): TerminalRow | null {
  return (db.prepare('SELECT * FROM terminals WHERE id = ?').get(id) as TerminalRow | undefined) ?? null;
}

export function listBySession(db: Database.Database, sessionId: string): TerminalRow[] {
  return db.prepare('SELECT * FROM terminals WHERE session_id = ? AND archived_at IS NULL ORDER BY sort_order ASC, created_at ASC')
    .all(sessionId) as TerminalRow[];
}

export function listArchivedBySession(db: Database.Database, sessionId: string): TerminalRow[] {
  return db.prepare('SELECT * FROM terminals WHERE session_id = ? AND archived_at IS NOT NULL ORDER BY archived_at DESC')
    .all(sessionId) as TerminalRow[];
}

/**
 * Cross-session lookup for the boot kickstart: every non-archived claude-code
 * terminal left in `status='working'`. At boot that status is the interrupted
 * signal — a thread that died mid-turn (clean shutdown skips the settle-to-waiting
 * write, and clearStalePids only touches sessions). The caller filters to
 * structured overseer threads and applies idempotency.
 */
export function listWorkingStructured(db: Database.Database): TerminalRow[] {
  return db.prepare(
    "SELECT * FROM terminals WHERE status = 'working' AND archived_at IS NULL AND type = 'claude-code'",
  ).all() as TerminalRow[];
}

export function updatePid(db: Database.Database, id: string, pid: number | null): void {
  db.prepare('UPDATE terminals SET pid = ? WHERE id = ?').run(pid, id);
}

export function updateExternalId(db: Database.Database, id: string, externalId: string): void {
  db.prepare('UPDATE terminals SET external_id = ? WHERE id = ?').run(externalId, id);
}

export function updateStatus(db: Database.Database, id: string, status: string): void {
  db.prepare('UPDATE terminals SET status = ? WHERE id = ?').run(status, id);
}

export function updateLabel(db: Database.Database, id: string, label: string): void {
  db.prepare('UPDATE terminals SET label = ? WHERE id = ?').run(label, id);
}

export function updateConfig(db: Database.Database, id: string, config: Record<string, any>): void {
  db.prepare('UPDATE terminals SET config = ? WHERE id = ?').run(JSON.stringify(config), id);
}

export function updateSortOrder(db: Database.Database, id: string, sortOrder: number): void {
  db.prepare('UPDATE terminals SET sort_order = ? WHERE id = ?').run(sortOrder, id);
}

export function updateSessionId(db: Database.Database, id: string, sessionId: string): void {
  db.prepare('UPDATE terminals SET session_id = ? WHERE id = ?').run(sessionId, id);
}

export function archive(db: Database.Database, id: string): void {
  db.prepare('UPDATE terminals SET archived_at = ?, pid = NULL WHERE id = ?').run(new Date().toISOString(), id);
}

export function unarchive(db: Database.Database, id: string): void {
  db.prepare('UPDATE terminals SET archived_at = NULL WHERE id = ?').run(id);
}

export function remove(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM terminals WHERE id = ?').run(id);
}

export function removeBySession(db: Database.Database, sessionId: string): void {
  db.prepare('DELETE FROM terminals WHERE session_id = ?').run(sessionId);
}
