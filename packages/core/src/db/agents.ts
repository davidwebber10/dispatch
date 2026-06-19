import type Database from 'better-sqlite3';

export type AgentProvider = 'claude-code' | 'codex';
export type ScheduleKind = 'one-shot' | 'recurring';
export type AgentRunStatus =
  | 'queued'
  | 'starting'
  | 'working'
  | 'needs_input'
  | 'idle'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface AgentScheduleRow {
  id: string;
  project_id: string;
  name: string;
  provider: AgentProvider;
  working_dir: string;
  prompt: string;
  schedule_kind: ScheduleKind;
  run_at: string | null;
  recurrence_rule: string | null;
  timezone: string;
  enabled: number;
  next_run_at: string | null;
  default_terminal_label: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentRunRow {
  id: string;
  schedule_id: string;
  project_id: string;
  terminal_id: string | null;
  provider: AgentProvider;
  prompt_snapshot: string;
  status: AgentRunStatus;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  external_session_id: string | null;
  last_opened_at: string | null;
  unread_since: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateScheduleInput {
  id: string;
  projectId: string;
  name: string;
  provider: AgentProvider;
  workingDir: string;
  prompt: string;
  scheduleKind: ScheduleKind;
  runAt: string | null;
  recurrenceRule: string | null;
  timezone: string;
  enabled: boolean;
  nextRunAt: string | null;
  defaultTerminalLabel: string | null;
}

export interface CreateRunInput {
  id: string;
  scheduleId: string;
  projectId: string;
  terminalId: string | null;
  provider: AgentProvider;
  promptSnapshot: string;
  status: AgentRunStatus;
  error: string | null;
  externalSessionId: string | null;
}

const nowIso = () => new Date().toISOString();

function pick<T, K extends keyof T>(fields: Partial<T>, key: K, fallback: T[K]): T[K] {
  return Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] as T[K] : fallback;
}

export function createSchedule(db: Database.Database, input: CreateScheduleInput): AgentScheduleRow {
  const now = nowIso();
  db.prepare(`
    INSERT INTO agent_schedules (
      id, project_id, name, provider, working_dir, prompt, schedule_kind,
      run_at, recurrence_rule, timezone, enabled, next_run_at,
      default_terminal_label, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.projectId,
    input.name,
    input.provider,
    input.workingDir,
    input.prompt,
    input.scheduleKind,
    input.runAt,
    input.recurrenceRule,
    input.timezone,
    input.enabled ? 1 : 0,
    input.nextRunAt,
    input.defaultTerminalLabel,
    now,
    now,
  );
  return getSchedule(db, input.id)!;
}

export function getSchedule(db: Database.Database, id: string): AgentScheduleRow | null {
  return (db.prepare('SELECT * FROM agent_schedules WHERE id = ?').get(id) as AgentScheduleRow | undefined) ?? null;
}

export function listSchedules(db: Database.Database, filter: { projectId?: string } = {}): AgentScheduleRow[] {
  if (filter.projectId) {
    return db.prepare('SELECT * FROM agent_schedules WHERE project_id = ? ORDER BY name ASC')
      .all(filter.projectId) as AgentScheduleRow[];
  }
  return db.prepare('SELECT * FROM agent_schedules ORDER BY project_id ASC, name ASC').all() as AgentScheduleRow[];
}

export function updateSchedule(
  db: Database.Database,
  id: string,
  fields: Partial<Omit<CreateScheduleInput, 'id'>>,
): AgentScheduleRow | null {
  const current = getSchedule(db, id);
  if (!current) return null;

  db.prepare(`
    UPDATE agent_schedules SET
      project_id = ?, name = ?, provider = ?, working_dir = ?, prompt = ?,
      schedule_kind = ?, run_at = ?, recurrence_rule = ?, timezone = ?,
      enabled = ?, next_run_at = ?, default_terminal_label = ?, updated_at = ?
    WHERE id = ?
  `).run(
    pick(fields, 'projectId', current.project_id),
    pick(fields, 'name', current.name),
    pick(fields, 'provider', current.provider),
    pick(fields, 'workingDir', current.working_dir),
    pick(fields, 'prompt', current.prompt),
    pick(fields, 'scheduleKind', current.schedule_kind),
    pick(fields, 'runAt', current.run_at),
    pick(fields, 'recurrenceRule', current.recurrence_rule),
    pick(fields, 'timezone', current.timezone),
    fields.enabled === undefined ? current.enabled : (fields.enabled ? 1 : 0),
    pick(fields, 'nextRunAt', current.next_run_at),
    pick(fields, 'defaultTerminalLabel', current.default_terminal_label),
    nowIso(),
    id,
  );
  return getSchedule(db, id);
}

export function deleteSchedule(db: Database.Database, id: string): void {
  // agent_runs has a FK to agent_schedules, so clear the run history first.
  db.transaction(() => {
    db.prepare('DELETE FROM agent_runs WHERE schedule_id = ?').run(id);
    db.prepare('DELETE FROM agent_schedules WHERE id = ?').run(id);
  })();
}

export function listDueSchedules(db: Database.Database, now: string): AgentScheduleRow[] {
  return db.prepare(`
    SELECT * FROM agent_schedules
    WHERE enabled = 1
      AND next_run_at IS NOT NULL
      AND next_run_at <= ?
      AND id NOT IN (
        SELECT schedule_id FROM agent_runs WHERE status IN ('queued', 'starting', 'working', 'needs_input')
      )
    ORDER BY next_run_at ASC
  `).all(now) as AgentScheduleRow[];
}

export function createRun(db: Database.Database, input: CreateRunInput): AgentRunRow {
  const now = nowIso();
  db.prepare(`
    INSERT INTO agent_runs (
      id, schedule_id, project_id, terminal_id, provider, prompt_snapshot,
      status, started_at, completed_at, error, external_session_id,
      last_opened_at, unread_since, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, ?, ?)
  `).run(
    input.id,
    input.scheduleId,
    input.projectId,
    input.terminalId,
    input.provider,
    input.promptSnapshot,
    input.status,
    input.error,
    input.externalSessionId,
    now,
    now,
  );
  return getRun(db, input.id)!;
}

export function getRun(db: Database.Database, id: string): AgentRunRow | null {
  return (db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as AgentRunRow | undefined) ?? null;
}

export function listRuns(
  db: Database.Database,
  filter: { projectId?: string; scheduleId?: string } = {},
): AgentRunRow[] {
  if (filter.scheduleId) {
    return db.prepare('SELECT * FROM agent_runs WHERE schedule_id = ? ORDER BY created_at DESC')
      .all(filter.scheduleId) as AgentRunRow[];
  }
  if (filter.projectId) {
    return db.prepare('SELECT * FROM agent_runs WHERE project_id = ? ORDER BY created_at DESC')
      .all(filter.projectId) as AgentRunRow[];
  }
  return db.prepare('SELECT * FROM agent_runs ORDER BY created_at DESC').all() as AgentRunRow[];
}

export function attachTerminal(db: Database.Database, runId: string, terminalId: string): AgentRunRow | null {
  db.prepare('UPDATE agent_runs SET terminal_id = ?, updated_at = ? WHERE id = ?').run(terminalId, nowIso(), runId);
  return getRun(db, runId);
}

export function updateRunStatus(
  db: Database.Database,
  runId: string,
  status: AgentRunStatus,
  opts: { error?: string | null; externalSessionId?: string | null; unread?: boolean } = {},
): AgentRunRow | null {
  const current = getRun(db, runId);
  if (!current) return null;

  const now = nowIso();
  const started = ['starting', 'working', 'needs_input'].includes(status) && !current.started_at ? now : current.started_at;
  const completed = ['succeeded', 'failed', 'cancelled'].includes(status) ? now : current.completed_at;

  db.prepare(`
    UPDATE agent_runs SET
      status = ?, started_at = ?, completed_at = ?, error = ?, external_session_id = ?,
      unread_since = ?, updated_at = ?
    WHERE id = ?
  `).run(
    status,
    started,
    completed,
    opts.error === undefined ? current.error : opts.error,
    opts.externalSessionId === undefined ? current.external_session_id : opts.externalSessionId,
    opts.unread ? now : current.unread_since,
    now,
    runId,
  );
  return getRun(db, runId);
}

export function markRunOpened(db: Database.Database, runId: string): AgentRunRow | null {
  const now = nowIso();
  db.prepare('UPDATE agent_runs SET last_opened_at = ?, unread_since = NULL, updated_at = ? WHERE id = ?')
    .run(now, now, runId);
  return getRun(db, runId);
}
