export type Provider = 'claude-code' | 'codex';

export type TerminalType = 'claude-code' | 'codex' | 'shell';

export type SessionStatus = 'working' | 'waiting' | 'needs_input' | 'error' | 'done';

export interface Session {
  id: string;
  provider: Provider;
  externalId: string | null;
  name: string;
  notes: string;
  status: SessionStatus;
  workingDir: string;
  tags: string[];
  pid: number | null;
  error: string | null;
  skipPermissions: boolean;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  archivedAt: string | null;
}

export interface SessionRow {
  id: string;
  provider: string;
  external_id: string | null;
  name: string;
  notes: string;
  status: string;
  working_dir: string;
  tags: string;
  pid: number | null;
  error: string | null;
  skip_permissions: number;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  archived_at: string | null;
}

export interface CreateSessionInput {
  provider: Provider;
  name?: string;
  workingDir: string;
  prompt?: string;
  externalId?: string;
  skipPermissions?: boolean;
}

export interface UpdateSessionInput {
  name?: string;
  notes?: string;
  tags?: string[];
}

export function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    provider: row.provider as Provider,
    externalId: row.external_id,
    name: row.name,
    notes: row.notes,
    status: row.status as SessionStatus,
    workingDir: row.working_dir,
    tags: JSON.parse(row.tags),
    pid: row.pid,
    error: row.error,
    skipPermissions: !!row.skip_permissions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    archivedAt: row.archived_at,
  };
}
