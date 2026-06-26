import type Database from 'better-sqlite3';

export interface IntegrationRow {
  id: string; name: string; type: string;
  command: string | null; args: string | null;
  url: string | null; headers: string | null; env: string | null;
  enabled: number; created_at: string; updated_at: string;
}

export interface Integration {
  id: string; name: string; type: 'stdio' | 'remote';
  command: string | null; args: string[];
  url: string | null; headers: Record<string, string>; env: Record<string, string>;
  enabled: boolean; createdAt: string; updatedAt: string;
}

export interface CreateIntegrationInput {
  id: string; name: string; type: 'stdio' | 'remote';
  command?: string | null; args?: string[];
  url?: string | null; headers?: Record<string, string>; env?: Record<string, string>;
  enabled?: boolean;
}

function parseObj(s: string | null): Record<string, string> { try { return s ? JSON.parse(s) : {}; } catch { return {}; } }
function parseArr(s: string | null): string[] { try { const v = s ? JSON.parse(s) : []; return Array.isArray(v) ? v : []; } catch { return []; } }

export function rowToIntegration(row: IntegrationRow): Integration {
  return {
    id: row.id, name: row.name, type: row.type === 'remote' ? 'remote' : 'stdio',
    command: row.command, args: parseArr(row.args),
    url: row.url, headers: parseObj(row.headers), env: parseObj(row.env),
    enabled: !!row.enabled, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function create(db: Database.Database, input: CreateIntegrationInput): Integration {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO integrations (id, name, type, command, args, url, headers, env, enabled, created_at, updated_at)
    VALUES (@id, @name, @type, @command, @args, @url, @headers, @env, @enabled, @created_at, @updated_at)`).run({
    id: input.id, name: input.name, type: input.type,
    command: input.command ?? null, args: JSON.stringify(input.args ?? []),
    url: input.url ?? null, headers: JSON.stringify(input.headers ?? {}), env: JSON.stringify(input.env ?? {}),
    enabled: input.enabled === false ? 0 : 1, created_at: now, updated_at: now,
  });
  return getById(db, input.id)!;
}

export function list(db: Database.Database): Integration[] {
  return (db.prepare('SELECT * FROM integrations ORDER BY created_at ASC, rowid ASC').all() as IntegrationRow[]).map(rowToIntegration);
}

export function getById(db: Database.Database, id: string): Integration | null {
  const row = db.prepare('SELECT * FROM integrations WHERE id = ?').get(id) as IntegrationRow | undefined;
  return row ? rowToIntegration(row) : null;
}

export function remove(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM integrations WHERE id = ?').run(id);
}

export function setEnabled(db: Database.Database, id: string, enabled: boolean): Integration | null {
  const res = db.prepare('UPDATE integrations SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, new Date().toISOString(), id);
  return res.changes > 0 ? getById(db, id) : null;
}
