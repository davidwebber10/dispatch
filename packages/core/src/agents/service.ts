import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import * as agentsDb from '../db/agents.js';
import { computeNextRunAt } from './recurrence.js';
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
  /**
   * Launch the provider in autonomous "runner" mode with the prompt as a launch
   * arg, so it executes the prompt to completion (and the process exits when
   * done) instead of opening an interactive REPL we type into.
   */
  createRunnerTerminal(
    sessionId: string,
    type: 'claude-code' | 'codex',
    label: string | undefined,
    workingDir: string | undefined,
    prompt: string,
  ): { id: string; externalId?: string | null };
  stopTerminal(terminalId: string): void;
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

export class AgentService {
  constructor(
    private db: Database.Database,
    private sessionService: SessionTerminalService,
    private broadcaster: EventBroadcaster,
  ) {}

  // The server is authoritative for next_run_at: derive it from the schedule's
  // rule whenever it's created/updated (disabled schedules never have one).
  private nextFor(row: agentsDb.AgentScheduleRow): string | null {
    return row.enabled === 1 ? computeNextRunAt(row, new Date().toISOString()) : null;
  }

  private withComputedNextRun(row: agentsDb.AgentScheduleRow): agentsDb.AgentScheduleRow {
    const next = this.nextFor(row);
    if (next === row.next_run_at) return row;
    return agentsDb.updateSchedule(this.db, row.id, { nextRunAt: next }) ?? row;
  }

  createSchedule(input: CreateScheduleRequest): AgentSchedule {
    const row = this.withComputedNextRun(agentsDb.createSchedule(this.db, { id: uuid(), ...input }));
    const schedule = toSchedule(row);
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
    const schedule = toSchedule(this.withComputedNextRun(row));
    this.broadcaster.broadcast({ type: 'agent:schedule-updated', schedule });
    return schedule;
  }

  deleteSchedule(id: string): boolean {
    const existing = agentsDb.getSchedule(this.db, id);
    if (!existing) return false;
    // Stop any live terminals spawned by this agent's runs before removing it.
    for (const run of agentsDb.listRuns(this.db, { scheduleId: id })) {
      if (run.terminal_id) {
        try { this.sessionService.stopTerminal(run.terminal_id); } catch { /* best effort */ }
      }
    }
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
      // Launch the provider headlessly WITH the prompt so it actually executes
      // the run autonomously to completion (and exits), instead of opening an
      // interactive TUI and typing the prompt into it.
      const terminal = this.sessionService.createRunnerTerminal(
        schedule.project_id,
        schedule.provider,
        schedule.default_terminal_label || schedule.name,
        schedule.working_dir,
        schedule.prompt,
      );
      run = agentsDb.attachTerminal(this.db, run.id, terminal.id)!;
      run = agentsDb.updateRunStatus(this.db, run.id, 'working', { externalSessionId: terminal.externalId ?? null })!;
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
        const nextRunAt = computeNextRunAt(schedule, now);
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

  /**
   * Finalize an agent run when its runner process exits. A clean exit (code 0)
   * transitions the run to 'succeeded'; any non-zero/abnormal exit transitions
   * it to 'failed'. No-op when the terminal isn't backing a run, or the run has
   * already reached a terminal state (e.g. it was cancelled, which kills the
   * PTY and would otherwise re-fire this on exit).
   */
  handleTerminalExit(terminalId: string, exitCode: number): AgentRun | null {
    const row = this.db
      .prepare('SELECT id, status FROM agent_runs WHERE terminal_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(terminalId) as { id: string; status: agentsDb.AgentRunStatus } | undefined;
    if (!row) return null;

    const ACTIVE: agentsDb.AgentRunStatus[] = ['queued', 'starting', 'working', 'needs_input', 'idle'];
    if (!ACTIVE.includes(row.status)) return null;

    const status: agentsDb.AgentRunStatus = exitCode === 0 ? 'succeeded' : 'failed';
    const error = exitCode === 0 ? null : `Process exited with code ${exitCode}`;
    const run = toRun(agentsDb.updateRunStatus(this.db, row.id, status, { error, unread: true })!);
    this.broadcaster.broadcast({ type: 'agent:run-updated', run });
    return run;
  }
}
