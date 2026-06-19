import type Database from 'better-sqlite3';
import type { SessionRow } from '../types.js';

interface CreateInput {
  id: string;
  provider: string;
  name: string;
  workingDir: string;
  externalId?: string;
  skipPermissions?: boolean;
}

export function create(db: Database.Database, input: CreateInput): string {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO sessions (id, provider, external_id, name, working_dir, skip_permissions, status, created_at, updated_at, last_activity_at)
    VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?)
  `).run(input.id, input.provider, input.externalId ?? null, input.name, input.workingDir, input.skipPermissions ? 1 : 0, now, now, now);
  return input.id;
}

export function getById(db: Database.Database, id: string): SessionRow | null {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | null;
}

export function list(db: Database.Database, status?: string): SessionRow[] {
  if (status) {
    return db.prepare('SELECT * FROM sessions WHERE archived_at IS NULL AND status = ? ORDER BY sort_order ASC, last_activity_at DESC')
      .all(status) as SessionRow[];
  }
  return db.prepare('SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY sort_order ASC, last_activity_at DESC')
    .all() as SessionRow[];
}

export function update(db: Database.Database, id: string, fields: { name?: string; notes?: string; tags?: string[] }): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (fields.name !== undefined) { sets.push('name = ?'); values.push(fields.name); }
  if (fields.notes !== undefined) { sets.push('notes = ?'); values.push(fields.notes); }
  if (fields.tags !== undefined) { sets.push('tags = ?'); values.push(JSON.stringify(fields.tags)); }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function updateStatus(db: Database.Database, id: string, status: string): void {
  const now = new Date().toISOString();
  db.prepare('UPDATE sessions SET status = ?, last_activity_at = ?, updated_at = ? WHERE id = ?')
    .run(status, now, now, id);
}

export function updatePid(db: Database.Database, id: string, pid: number | null): void {
  db.prepare('UPDATE sessions SET pid = ?, updated_at = ? WHERE id = ?')
    .run(pid, new Date().toISOString(), id);
}

export function touchActivity(db: Database.Database, id: string): void {
  db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
}

export function setError(db: Database.Database, id: string, error: string): void {
  db.prepare('UPDATE sessions SET error = ?, updated_at = ? WHERE id = ?')
    .run(error, new Date().toISOString(), id);
}

export function updateExternalId(db: Database.Database, id: string, externalId: string): void {
  db.prepare('UPDATE sessions SET external_id = ?, updated_at = ? WHERE id = ?')
    .run(externalId, new Date().toISOString(), id);
}

export function archive(db: Database.Database, id: string): void {
  db.prepare('UPDATE sessions SET archived_at = ?, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), new Date().toISOString(), id);
}

export function clearStalePids(db: Database.Database, alivePids: Set<number>): void {
  const sessions = db.prepare('SELECT id, pid FROM sessions WHERE pid IS NOT NULL AND archived_at IS NULL').all() as { id: string; pid: number }[];
  for (const s of sessions) {
    if (!alivePids.has(s.pid)) {
      db.prepare('UPDATE sessions SET status = ?, pid = NULL, updated_at = ? WHERE id = ?')
        .run('waiting', new Date().toISOString(), s.id);
    }
  }
}
