import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import * as agentsDb from '../db/agents.js';
import type { EventBroadcaster } from '../ws/events.js';

export interface AgentSchedule {
  id: string;
  projectId: string;
  name: string;
  provider: agentsDb.AgentProvider;
  workingDir: string;
  prompt: string;
  scheduleKind: agentsDb.ScheduleKind;
  runAt: string | null;
  recurrenceRule: string | null;
  timezone: string;
  enabled: boolean;
  nextRunAt: string | null;
  defaultTerminalLabel: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRun {
  id: string;
  scheduleId: string;
  projectId: string;
  terminalId: string | null;
  provider: agentsDb.AgentProvider;
  promptSnapshot: string;
  status: agentsDb.AgentRunStatus;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  externalSessionId: string | null;
  lastOpenedAt: string | null;
  unreadSince: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SessionTerminalService {
  createTerminal(
    sessionId: string,
    type: 'claude-code' | 'codex',
    label?: string,
    skipPermissions?: boolean,
    workingDir?: string,
    externalId?: string,
  ): { id: string; externalId?: string | null };
  stopTerminal(terminalId: string): void;
  writeToTerminal(terminalId: string, data: string): void;
}

export interface CreateScheduleRequest {
  projectId: string;
  name: string;
  provider: agentsDb.AgentProvider;
  workingDir: string;
  prompt: string;
  scheduleKind: agentsDb.ScheduleKind;
  runAt: string | null;
  recurrenceRule: string | null;
  timezone: string;
  enabled: boolean;
  nextRunAt: string | null;
  defaultTerminalLabel: string | null;
}

export function toSchedule(row: agentsDb.AgentScheduleRow): AgentSchedule {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    provider: row.provider,
    workingDir: row.working_dir,
    prompt: row.prompt,
    scheduleKind: row.schedule_kind,
    runAt: row.run_at,
    recurrenceRule: row.recurrence_rule,
    timezone: row.timezone,
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
    defaultTerminalLabel: row.default_terminal_label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toRun(row: agentsDb.AgentRunRow): AgentRun {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    projectId: row.project_id,
    terminalId: row.terminal_id,
    provider: row.provider,
    promptSnapshot: row.prompt_snapshot,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
    externalSessionId: row.external_session_id,
    lastOpenedAt: row.last_opened_at,
    unreadSince: row.unread_since,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function nextRunAtFor(schedule: agentsDb.AgentScheduleRow, nowIso: string): string | null {
  if (schedule.schedule_kind !== 'recurring') return null;
  if (!schedule.recurrence_rule) return null;

  let rule: any;
  try {
    rule = JSON.parse(schedule.recurrence_rule);
  } catch {
    return null;
  }

  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) return null;

  if (rule.type === 'daily') {
    const [hourRaw, minuteRaw] = String(rule.time ?? '00:00').split(':');
    const hour = Number(hourRaw);
    const minute = Number(minuteRaw);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return null;

    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0));
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString();
  }

  if (rule.type === 'interval-hours') {
    const hours = Number(rule.hours ?? 24);
    if (Number.isNaN(hours) || hours <= 0) return null;
    return new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();
  }

  return null;
}

export class AgentService {
  constructor(
    private db: Database.Database,
    private sessionService: SessionTerminalService,
    private broadcaster: EventBroadcaster,
  ) {}

  createSchedule(input: CreateScheduleRequest): AgentSchedule {
    const schedule = toSchedule(agentsDb.createSchedule(this.db, { id: uuid(), ...input }));
    this.broadcaster.broadcast({ type: 'agent:schedule-created', schedule });
    return schedule;
  }

  listSchedules(filter: { projectId?: string } = {}): AgentSchedule[] {
    return agentsDb.listSchedules(this.db, filter).map(toSchedule);
  }

  getSchedule(id: string): AgentSchedule | null {
    const row = agentsDb.getSchedule(this.db, id);
    return row ? toSchedule(row) : null;
  }

  updateSchedule(id: string, fields: Partial<CreateScheduleRequest>): AgentSchedule | null {
    const row = agentsDb.updateSchedule(this.db, id, fields);
    if (!row) return null;
    const schedule = toSchedule(row);
    this.broadcaster.broadcast({ type: 'agent:schedule-updated', schedule });
    return schedule;
  }

  deleteSchedule(id: string): boolean {
    const existing = agentsDb.getSchedule(this.db, id);
    if (!existing) return false;
    agentsDb.deleteSchedule(this.db, id);
    this.broadcaster.broadcast({ type: 'agent:schedule-removed', scheduleId: id });
    return true;
  }

  listRuns(filter: { projectId?: string; scheduleId?: string } = {}): AgentRun[] {
    return agentsDb.listRuns(this.db, filter).map(toRun);
  }

  getRun(id: string): AgentRun | null {
    const row = agentsDb.getRun(this.db, id);
    return row ? toRun(row) : null;
  }

  markRunOpened(id: string): AgentRun | null {
    const row = agentsDb.markRunOpened(this.db, id);
    if (!row) return null;
    const run = toRun(row);
    this.broadcaster.broadcast({ type: 'agent:run-updated', run });
    return run;
  }

  runNow(scheduleId: string): AgentRun {
    const schedule = agentsDb.getSchedule(this.db, scheduleId);
    if (!schedule) throw new Error('Schedule not found');

    let run = agentsDb.createRun(this.db, {
      id: uuid(),
      scheduleId: schedule.id,
      projectId: schedule.project_id,
      terminalId: null,
      provider: schedule.provider,
      promptSnapshot: schedule.prompt,
      status: 'queued',
      error: null,
      externalSessionId: null,
    });
    this.broadcaster.broadcast({ type: 'agent:run-created', run: toRun(run) });

    try {
      run = agentsDb.updateRunStatus(this.db, run.id, 'starting')!;
      const terminal = this.sessionService.createTerminal(
        schedule.project_id,
        schedule.provider,
        schedule.default_terminal_label || schedule.name,
        false,
        schedule.working_dir,
        undefined,
      );
      run = agentsDb.attachTerminal(this.db, run.id, terminal.id)!;
      run = agentsDb.updateRunStatus(this.db, run.id, 'working', { externalSessionId: terminal.externalId ?? null })!;
      this.sessionService.writeToTerminal(terminal.id, `${schedule.prompt}\r`);
      this.broadcaster.broadcast({ type: 'agent:run-updated', run: toRun(run) });
      return toRun(run);
    } catch (err: any) {
      run = agentsDb.updateRunStatus(this.db, run.id, 'failed', { error: err.message, unread: true })!;
      this.broadcaster.broadcast({ type: 'agent:run-updated', run: toRun(run) });
      return toRun(run);
    }
  }

  processDueRuns(now: string = new Date().toISOString()): AgentRun[] {
    const due = agentsDb.listDueSchedules(this.db, now);
    return due.map(schedule => {
      const run = this.runNow(schedule.id);
      if (schedule.schedule_kind === 'one-shot') {
        const updated = agentsDb.updateSchedule(this.db, schedule.id, { enabled: false, nextRunAt: null });
        if (updated) {
          this.broadcaster.broadcast({ type: 'agent:schedule-updated', schedule: toSchedule(updated) });
        }
      } else {
        const nextRunAt = nextRunAtFor(schedule, now);
        const updated = agentsDb.updateSchedule(this.db, schedule.id, {
          enabled: nextRunAt != null,
          nextRunAt,
        });
        if (updated) {
          this.broadcaster.broadcast({ type: 'agent:schedule-updated', schedule: toSchedule(updated) });
        }
      }
      return run;
    });
  }

  cancelRun(id: string): AgentRun {
    const current = agentsDb.getRun(this.db, id);
    if (!current) throw new Error('Run not found');
    if (current.terminal_id) this.sessionService.stopTerminal(current.terminal_id);
    const run = toRun(agentsDb.updateRunStatus(this.db, id, 'cancelled', { unread: true })!);
    this.broadcaster.broadcast({ type: 'agent:run-updated', run });
    return run;
  }

  updateRunFromTerminalActivity(terminalId: string, activity: 'busy' | 'idle' | 'needs_input'): AgentRun | null {
    const row = this.db.prepare('SELECT id FROM agent_runs WHERE terminal_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(terminalId) as { id: string } | undefined;
    if (!row) return null;

    const status = activity === 'busy' ? 'working' : activity === 'needs_input' ? 'needs_input' : 'idle';
    const run = toRun(agentsDb.updateRunStatus(this.db, row.id, status, { unread: activity === 'needs_input' })!);
    this.broadcaster.broadcast({ type: 'agent:run-updated', run });
    return run;
  }
}
