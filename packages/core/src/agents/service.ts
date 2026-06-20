import fs from 'fs';
import path from 'path';
import { StringDecoder } from 'string_decoder';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import * as agentsDb from '../db/agents.js';
import { computeNextRunAt } from './recurrence.js';
import { RunStreamParser, runEventToStep, type RunEvent, type RunStep } from './run-stream.js';
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
  costUsd: number | null;
  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  model: string | null;
  numTurns: number | null;
  resultText: string | null;
  transcriptPath: string | null;
  exitCode: number | null;
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

export interface AgentOverviewAgent {
  scheduleId: string;
  name: string;
  provider: string;
  enabled: boolean;
  nextRunAt: string | null;
  spendUsd: number;
  runCount: number;
  lastRunAt: string | null;
  running: boolean;
}

export interface AgentOverviewProject {
  projectId: string;
  projectName: string | null;
  spendUsd: number;
  runningCount: number;
  agents: AgentOverviewAgent[];
}

export interface AgentOverview {
  totalSpendUsd: number;
  totalRuns: number;
  runningCount: number;
  agentCount: number;
  projects: AgentOverviewProject[];
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
    costUsd: row.cost_usd,
    totalTokens: row.total_tokens,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    model: row.model,
    numTurns: row.num_turns,
    resultText: row.result_text,
    transcriptPath: row.transcript_path,
    exitCode: row.exit_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface RunStreamState {
  runId: string;
  terminalId: string;
  parser: RunStreamParser;
  decoder: StringDecoder;
  /** Transcript file path, or null when persistence is disabled (e.g. tests). */
  transcriptPath: string | null;
  lastAssistantText?: string;
  model?: string;
  finalized: boolean;
}

export class AgentService {
  /** Live stream parsers keyed by the runner terminalId. */
  private runStreams = new Map<string, RunStreamState>();

  constructor(
    private db: Database.Database,
    private sessionService: SessionTerminalService,
    private broadcaster: EventBroadcaster,
    /** Directory for persisted per-run JSONL transcripts (omit to skip persistence, e.g. in tests). */
    private runsDir?: string,
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

  /**
   * Cross-project agent overview: every agent with its all-time spend, run count,
   * last-run time and live running flag, grouped by project, plus grand totals.
   * Backs the mobile "Agents" tab. All aggregation is done in SQL.
   */
  overview(): AgentOverview {
    // Spend/run/active aggregation is done in SQL (agentsDb.agentOverview); here
    // we just group the per-agent rows by project and total them up.
    const projects = new Map<string, AgentOverviewProject>();
    let totalSpendUsd = 0;
    let totalRuns = 0;
    let runningCount = 0;
    let agentCount = 0;

    for (const r of agentsDb.agentOverview(this.db)) {
      agentCount += 1;
      const running = r.active_runs > 0;
      const spendUsd = r.spend_usd || 0;
      totalSpendUsd += spendUsd;
      totalRuns += r.run_count;
      if (running) runningCount += 1;

      let group = projects.get(r.project_id);
      if (!group) {
        group = { projectId: r.project_id, projectName: r.project_name, spendUsd: 0, runningCount: 0, agents: [] };
        projects.set(r.project_id, group);
      }
      group.spendUsd += spendUsd;
      if (running) group.runningCount += 1;
      group.agents.push({
        scheduleId: r.schedule_id,
        name: r.name,
        provider: r.provider,
        enabled: !!r.enabled,
        nextRunAt: r.next_run_at,
        spendUsd,
        runCount: r.run_count,
        lastRunAt: r.last_run_at,
        running,
      });
    }

    const grouped = [...projects.values()].sort(
      (a, b) => (b.runningCount - a.runningCount) || (b.spendUsd - a.spendUsd) || (a.projectName ?? '').localeCompare(b.projectName ?? ''),
    );
    return { totalSpendUsd, totalRuns, runningCount, agentCount, projects: grouped };
  }

  getRun(id: string): AgentRun | null {
    const row = agentsDb.getRun(this.db, id);
    return row ? toRun(row) : null;
  }

  /**
   * Re-parse a run's persisted JSONL transcript into RunSteps (timeline + activity
   * log). Used to hydrate the RunnerView for completed runs / on (re)open; live
   * runs additionally receive incremental steps over the events socket.
   */
  getRunSteps(runId: string): RunStep[] {
    const run = agentsDb.getRun(this.db, runId);
    if (!run || !run.transcript_path) return [];
    let raw: string;
    try {
      raw = fs.readFileSync(run.transcript_path, 'utf8');
    } catch {
      return [];
    }
    const parser = new RunStreamParser(run.provider);
    const events: RunEvent[] = [...parser.feed(raw), ...parser.flush()];
    return events.map(runEventToStep);
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
      // Set up structured-output parsing + transcript capture for this run's PTY
      // before it produces output, so we miss nothing.
      this.beginRunStream(run.id, terminal.id, schedule.provider);
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
    if (current.terminal_id) {
      this.endRunStream(current.terminal_id);
      this.sessionService.stopTerminal(current.terminal_id);
    }
    const run = toRun(agentsDb.updateRunStatus(this.db, id, 'cancelled', { unread: true })!);
    this.broadcaster.broadcast({ type: 'agent:run-updated', run });
    return run;
  }

  updateRunFromTerminalActivity(terminalId: string, activity: 'busy' | 'idle' | 'needs_input'): AgentRun | null {
    // For autonomous runner terminals the structured stream parser is the source
    // of truth for status — ignore the coarse busy/idle heuristic so a thinking
    // pause is never misread as 'idle' or completion.
    if (this.runStreams.has(terminalId)) return null;

    const row = this.db.prepare('SELECT id FROM agent_runs WHERE terminal_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(terminalId) as { id: string } | undefined;
    if (!row) return null;

    const status = activity === 'busy' ? 'working' : activity === 'needs_input' ? 'needs_input' : 'idle';
    const run = toRun(agentsDb.updateRunStatus(this.db, row.id, status, { unread: activity === 'needs_input' })!);
    this.broadcaster.broadcast({ type: 'agent:run-updated', run });
    return run;
  }

  // --- Structured run streaming -------------------------------------------

  /**
   * Begin parsing a runner terminal's stdout: open a transcript file (if a runs
   * dir is configured) and a stream parser. Called synchronously right after the
   * runner PTY is spawned so no early output is missed.
   */
  private beginRunStream(runId: string, terminalId: string, provider: agentsDb.AgentProvider): void {
    let transcriptPath: string | null = null;
    if (this.runsDir) {
      try {
        fs.mkdirSync(this.runsDir, { recursive: true });
        transcriptPath = path.join(this.runsDir, `${runId}.jsonl`);
        fs.writeFileSync(transcriptPath, ''); // truncate any prior partial file
        agentsDb.attachTranscript(this.db, runId, transcriptPath);
      } catch (err) {
        console.error('agent run transcript open failed', err);
        transcriptPath = null;
      }
    }
    this.runStreams.set(terminalId, {
      runId,
      terminalId,
      parser: new RunStreamParser(provider),
      decoder: new StringDecoder('utf8'),
      transcriptPath,
      finalized: false,
    });
  }

  /**
   * Feed a chunk of a runner terminal's raw PTY output. Persists it verbatim to
   * the transcript and parses it into structured run steps that are broadcast
   * live; a parsed `result` event finalizes the run with its telemetry.
   */
  onRunnerData(terminalId: string, data: Buffer | string): void {
    const state = this.runStreams.get(terminalId);
    if (!state) return;
    if (state.transcriptPath) {
      try {
        fs.appendFileSync(state.transcriptPath, data);
      } catch { /* best effort */ }
    }
    const text = typeof data === 'string' ? data : state.decoder.write(data);
    let events: RunEvent[];
    try {
      events = state.parser.feed(text);
    } catch {
      return;
    }
    for (const ev of events) this.handleRunEvent(state, ev);
  }

  private handleRunEvent(state: RunStreamState, ev: RunEvent): void {
    if (ev.kind === 'assistant-text') state.lastAssistantText = ev.text;
    if ((ev.kind === 'init' || ev.kind === 'result') && ev.model) state.model = ev.model;

    const step = runEventToStep(ev);
    this.broadcaster.broadcast({
      type: 'agent:run-step',
      runId: state.runId,
      terminalId: state.terminalId,
      step: { ...step, ts: new Date().toISOString() },
    });

    if (ev.kind === 'result') this.finalizeFromResult(state, ev);
  }

  private finalizeFromResult(state: RunStreamState, ev: Extract<RunEvent, { kind: 'result' }>): void {
    if (state.finalized) return;
    state.finalized = true;
    const row = agentsDb.finalizeRun(this.db, state.runId, {
      status: ev.isError ? 'failed' : 'succeeded',
      error: ev.isError ? (ev.result ?? 'Agent reported an error') : null,
      costUsd: ev.costUsd ?? null,
      totalTokens: ev.totalTokens ?? null,
      inputTokens: ev.inputTokens ?? null,
      outputTokens: ev.outputTokens ?? null,
      model: state.model ?? ev.model ?? null,
      numTurns: ev.numTurns ?? null,
      resultText: ev.result ?? state.lastAssistantText ?? null,
      unread: true,
    });
    if (row) this.broadcaster.broadcast({ type: 'agent:run-updated', run: toRun(row) });
  }

  /** Flush + close a run's stream (on completion or cancellation). Idempotent. */
  private endRunStream(terminalId: string): void {
    const state = this.runStreams.get(terminalId);
    if (!state) return;
    this.runStreams.delete(terminalId);
    try {
      for (const ev of state.parser.flush()) this.handleRunEvent(state, ev);
    } catch { /* best effort */ }
  }

  /**
   * Finalize an agent run when its runner process exits. A clean exit (code 0)
   * transitions the run to 'succeeded'; any non-zero/abnormal exit transitions
   * it to 'failed'. No-op when the terminal isn't backing a run, or the run has
   * already reached a terminal state (e.g. it was cancelled, which kills the
   * PTY and would otherwise re-fire this on exit).
   */
  handleTerminalExit(terminalId: string, exitCode: number): AgentRun | null {
    // Flush any buffered final events first — a `result` event in the last chunk
    // finalizes the run (with full telemetry) before we fall back to exit code.
    this.endRunStream(terminalId);

    const row = this.db
      .prepare('SELECT id, status FROM agent_runs WHERE terminal_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(terminalId) as { id: string; status: agentsDb.AgentRunStatus } | undefined;
    if (!row) return null;

    const ACTIVE: agentsDb.AgentRunStatus[] = ['queued', 'starting', 'working', 'needs_input', 'idle'];
    if (!ACTIVE.includes(row.status)) return null; // already finalized (result event or cancel)

    // Fallback for crashes / runs that exited without a parsed result event.
    const status: agentsDb.AgentRunStatus = exitCode === 0 ? 'succeeded' : 'failed';
    const error = exitCode === 0 ? null : `Process exited with code ${exitCode}`;
    const run = toRun(agentsDb.finalizeRun(this.db, row.id, { status, error, exitCode, unread: true })!);
    this.broadcaster.broadcast({ type: 'agent:run-updated', run });
    return run;
  }
}
