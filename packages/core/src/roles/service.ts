// RolesService — discovery + enable/disable for scheduled roles (the "pets" of the
// scheduled-roles design; docs/superpowers/specs/2026-09-02-scheduled-roles-design.md §1).
// Discovery (list()) only ever reads the roles directory and the DB; it never creates or
// starts anything. enable()/disable() are the only mutating entry points, and they are a
// deliberate per-machine act — never triggered implicitly by discovery.
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { appendRunLog, listRoles, readRoleMemory, readRunLogTail, rolesRootDir, type RoleDefinition } from './definition.js';
import { buildSeedMessage } from './seed.js';
import * as agentsDb from '../db/agents.js';
import * as terminalsDb from '../db/terminals.js';
import type { AgentService, RoleRunner } from '../agents/service.js';
import type { SessionService } from '../sessions/service.js';
import type { StatusService } from '../status/service.js';
import type { Session } from '../types.js';

/** Number of past run reports fed into a fresh incarnation's seed (spec §2, "tail of log.jsonl"). */
const LOG_TAIL_LINES = 3;

type RunOutcome = 'ok' | 'attention' | 'failed';

/** The runner's final ```json contract block (see seed.ts's OUTPUT_CONTRACT), when it can be
 *  recovered from `config.lastOutcome.summary` alone — see the module doc comment on
 *  `finalizeRoleRun` for why that's the only text available without new transcript plumbing. */
interface RunContract {
  outcome: RunOutcome;
  summary: string;
  links?: string[];
  proposedBriefChanges?: string;
}

function extractContract(summary: string | undefined): RunContract | null {
  if (!summary) return null;
  const m = /```json\s*([\s\S]*?)```/.exec(summary);
  if (!m) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(m[1]); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.outcome !== 'ok' && obj.outcome !== 'attention' && obj.outcome !== 'failed') return null;
  if (typeof obj.summary !== 'string') return null;
  return {
    outcome: obj.outcome,
    summary: obj.summary,
    links: Array.isArray(obj.links) ? obj.links.filter((l): l is string => typeof l === 'string') : undefined,
    proposedBriefChanges: typeof obj.proposedBriefChanges === 'string' ? obj.proposedBriefChanges : undefined,
  };
}

export interface RoleStatusEntry {
  def: RoleDefinition;
  enabled: boolean;
  scheduleId?: string;
  nextRunAt?: string | null;
  consecutiveFailures?: number;
  /** Set when the role's role.md failed to parse; the entry is otherwise a disabled stub. */
  error?: string;
}

export interface RolesServiceDeps {
  db: Database.Database;
  agentService: AgentService;
  sessionService: SessionService;
  rolesRoot?: string;
}

const OPERATIONS_PROJECT_NAME = 'Operations';

/** Build an Error carrying an HTTP `status` so a route can map it to a response code. */
function statusError(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

/** A placeholder def for a role whose role.md failed to parse — enough shape to render
 *  a disabled list entry alongside the parse error, without pretending it's valid. */
function errorStub(root: string, name: string): RoleDefinition {
  return {
    name,
    dir: path.join(root, name),
    project: null,
    global: false,
    agentType: '',
    schedule: null,
    authority: 'observe',
    wallClockCapMin: 45,
    brief: '',
  };
}

export class RolesService implements RoleRunner {
  private db: Database.Database;
  private agentService: AgentService;
  private sessionService: SessionService;
  private rolesRoot: string;

  /** Task 7 seam: retry/auto-disable supervision hangs off a finalized run's outcome.
   *  Left unset (no-op) here — wiring it up is Task 7's job, not this one's. */
  onRunFinalized?: (schedule: agentsDb.AgentScheduleRow | null, run: agentsDb.AgentRunRow, outcome: RunOutcome) => void;

  constructor(deps: RolesServiceDeps) {
    this.db = deps.db;
    this.agentService = deps.agentService;
    this.sessionService = deps.sessionService;
    this.rolesRoot = deps.rolesRoot ?? rolesRootDir();
  }

  /** Scan the roles dir and merge in schedule state by role_name. Never mutates anything. */
  list(): RoleStatusEntry[] {
    const { roles, errors } = listRoles(this.rolesRoot);
    const entries = roles.map((def) => this.entryFor(def));
    for (const e of errors) entries.push(this.entryFor(errorStub(this.rolesRoot, e.name), e.error));
    return entries;
  }

  /** Upsert the agent_schedules row for this role (keyed by role_name) and turn it on.
   *  Throws (404-shaped) if the role directory doesn't exist, (400-shaped) if role.md
   *  fails to parse or its project binding can't be resolved. */
  enable(name: string): RoleStatusEntry {
    const def = this.requireDef(name);
    const project = this.resolveProject(def);
    const recurrenceRule = JSON.stringify(def.schedule);
    const timezone = def.tz || 'UTC';

    const existing = agentsDb.getScheduleByRoleName(this.db, name);
    if (existing) {
      this.agentService.updateSchedule(existing.id, {
        projectId: project.id,
        name: def.name,
        provider: 'claude-code',
        workingDir: project.workingDir,
        prompt: '',
        scheduleKind: 'recurring',
        recurrenceRule,
        timezone,
        enabled: true,
      });
    } else {
      this.agentService.createSchedule({
        projectId: project.id,
        name: def.name,
        provider: 'claude-code',
        workingDir: project.workingDir,
        prompt: '',
        scheduleKind: 'recurring',
        runAt: null,
        recurrenceRule,
        timezone,
        enabled: true,
        nextRunAt: null,
        defaultTerminalLabel: null,
        roleName: name,
      });
    }

    return this.entryFor(def);
  }

  /** Flip enabled off; the row (and its failure history) is kept. A role that was never
   *  enabled is a no-op. Throws (404-shaped) only when the role directory doesn't exist. */
  disable(name: string): RoleStatusEntry {
    const { def, errorMessage } = this.requireKnown(name);
    const row = agentsDb.getScheduleByRoleName(this.db, name);
    if (row && row.enabled === 1) {
      this.agentService.updateSchedule(row.id, { enabled: false });
    }
    return this.entryFor(def, errorMessage);
  }

  /** Find-or-create the shared project for global roles (docs §1: global roles run
   *  against a dedicated ~/.dispatch/operations workspace, not a per-role directory). */
  ensureOperationsProject(): Session {
    const existing = this.sessionService.list().find((s) => s.name === OPERATIONS_PROJECT_NAME);
    if (existing) return existing;
    return this.sessionService.create({
      provider: 'claude-code',
      name: OPERATIONS_PROJECT_NAME,
      workingDir: path.join(os.homedir(), '.dispatch', 'operations'),
    });
  }

  private resolveProject(def: RoleDefinition): Session {
    if (def.global) return this.ensureOperationsProject();
    const project = this.sessionService.list().find((s) => s.name === def.project);
    if (!project) throw statusError(400, `project "${def.project}" not found for role "${def.name}"`);
    return project;
  }

  /** Look up a role's def, throwing 404 if unknown and 400 with the parse message if invalid. */
  private requireDef(name: string): RoleDefinition {
    const { roles, errors } = listRoles(this.rolesRoot);
    const err = errors.find((e) => e.name === name);
    if (err) throw statusError(400, err.error);
    const def = roles.find((r) => r.name === name);
    if (!def) throw statusError(404, `role "${name}" not found`);
    return def;
  }

  /** Like requireDef, but tolerates (rather than throws on) a role.md parse error — used by
   *  disable(), which must still be able to turn off a role that broke after it was enabled. */
  private requireKnown(name: string): { def: RoleDefinition; errorMessage?: string } {
    const { roles, errors } = listRoles(this.rolesRoot);
    const def = roles.find((r) => r.name === name);
    if (def) return { def };
    const err = errors.find((e) => e.name === name);
    if (err) return { def: errorStub(this.rolesRoot, name), errorMessage: err.error };
    throw statusError(404, `role "${name}" not found`);
  }

  private entryFor(def: RoleDefinition, errorMessage?: string): RoleStatusEntry {
    const row = agentsDb.getScheduleByRoleName(this.db, def.name);
    const entry: RoleStatusEntry = {
      def,
      enabled: !!row && row.enabled === 1,
      scheduleId: row?.id,
      nextRunAt: row ? row.next_run_at : undefined,
      consecutiveFailures: row?.consecutive_failures,
    };
    if (errorMessage) entry.error = errorMessage;
    return entry;
  }

  // --- Run lifecycle (Task 6: the live scheduler's role-run branch) --------------

  /**
   * Fire one incarnation of a role-backed schedule (AgentService.runNow's role branch,
   * via `agentService.setRoleRunner(this)`). Re-reads + re-parses role.md fresh — never
   * cached — so a brief edited since the last fire is picked up with no re-registration.
   * Throws on any failure (parse, unresolvable project, spawn); runNow's own catch marks
   * the run failed with the thrown message, so this method deliberately does no failure
   * bookkeeping of its own. On success it attaches the terminal and moves the run to
   * 'working' itself — the caller only has stale copies of both after this returns.
   */
  spawnRoleRun(schedule: agentsDb.AgentScheduleRow, run: agentsDb.AgentRunRow): void {
    if (!schedule.role_name) throw new Error('schedule has no role_name');
    const def = this.requireDef(schedule.role_name);
    const project = this.resolveProject(def);

    const nowIso = new Date().toISOString();
    const seed = buildSeedMessage({
      def,
      memory: readRoleMemory(def.dir),
      logTail: readRunLogTail(def.dir, LOG_TAIL_LINES),
      nowIso,
    });

    const label = `${def.name} · ${nowIso.slice(0, 10)}`;
    const config: Record<string, unknown> = {
      transport: 'structured',
      role: 'agent',
      agentType: def.agentType,
      ...(def.model ? { model: def.model } : {}),
      mission: def.name,
      roleRun: def.name,
      roleAuthority: def.authority,
      spawnDepth: 1,
    };

    const terminal = this.sessionService.createTerminal(project.id, 'claude-code', label, true, project.workingDir, undefined, config);
    // Attach BEFORE sending the seed: if sendThreadMessage throws below, the terminal is
    // already attached to the run (so nothing double-spawns it), and the catch cleans up
    // the orphan itself — attaching after the send would leave a live, unattached, never-
    // seeded runner that nothing else knows to remove.
    agentsDb.attachTerminal(this.db, run.id, terminal.id);

    try {
      this.sessionService.sendThreadMessage(terminal.id, seed, 'coordinator');
    } catch (err) {
      // The terminal spawned but never got its task — archive it rather than leave a dead
      // runner in the rail. Rethrow (don't set failed here) so runNow's existing catch does
      // the one, consistent "fail the run" bookkeeping for every spawnRoleRun failure mode.
      try { this.sessionService.removeTerminal(terminal.id); } catch { /* best effort */ }
      throw err;
    }

    agentsDb.updateRunStatus(this.db, run.id, 'working', { externalSessionId: terminal.externalId ?? null });
  }

  /** Subscribe the settled-listener that closes out a finished role-run incarnation
   *  (server.ts wiring — mirrors wireThreadSettledPush's shape). One subscription for
   *  the process lifetime; ignores every settle that isn't a role-run terminal. */
  wireSettled(statusService: StatusService): void {
    statusService.addThreadSettledListener(({ terminalId }) => {
      // Structured threads settle via StatusService.markIdle/markNeedsInput, which fire
      // this listener SYNCHRONOUSLY and BEFORE SessionService.noteTurnOutcome persists
      // config.lastOutcome for the very turn that just ended (server.ts calls markIdle
      // then noteTurnOutcome, in that order, for both the 'idle' and 'needs-help' structured
      // events). Reading config.lastOutcome right here would see stale or entirely absent
      // data. noteTurnOutcome runs synchronously in the same call stack, though, so it has
      // always completed by the next event-loop tick — deferring one tick is enough, is
      // confined to this listener, and needs no change to that shared ordering.
      setImmediate(() => {
        try { this.finalizeRoleRun(terminalId); }
        catch { /* a settled listener must never throw */ }
      });
    });
  }

  /** Close out one role-run incarnation: append its report to log.jsonl, settle the
   *  run row, and archive the runner terminal. No-ops for any terminal that isn't a
   *  role-run terminal (config.roleRun unset) or has no matching run row. `threadStatus`
   *  isn't consulted: the settled edge only ever fires for 'waiting'/'needs_input'
   *  terminal statuses (see StatusService.apply), never 'error' — the only signal for a
   *  bad outcome available here is the runner's own declaredState (below). */
  private finalizeRoleRun(terminalId: string): void {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return;
    let config: Record<string, any> = {};
    try { config = JSON.parse(terminal.config || '{}'); } catch { /* malformed → not a role run */ }
    const roleName = config.roleRun;
    if (typeof roleName !== 'string' || !roleName) return; // ordinary thread — ignore

    const run = agentsDb.getRunByTerminalId(this.db, terminalId);
    if (!run) return;
    // Already closed out (e.g. a duplicate settle edge) — appendRunLog must run at most
    // once per run. Terminal statuses per agentsDb.AgentRunStatus: succeeded/failed/cancelled.
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') return;

    // The role may have been edited or deleted since this incarnation spawned; fall back
    // to a stub with the same directory (errorStub) so the report still lands somewhere.
    const { roles } = listRoles(this.rolesRoot);
    const def = roles.find((r) => r.name === roleName) ?? errorStub(this.rolesRoot, roleName);

    const lastOutcome = config.lastOutcome as
      | { summary?: string; needsHelp?: boolean; declaredState?: string }
      | undefined;
    const contract = extractContract(lastOutcome?.summary);

    let outcome: RunOutcome;
    let summary: string;
    let links: string[];
    let proposedBriefChanges: string | undefined;
    if (contract) {
      outcome = contract.outcome;
      summary = contract.summary;
      links = contract.links ?? [];
      proposedBriefChanges = contract.proposedBriefChanges;
    } else {
      // Permitted v1 simplification (task brief): no fenced contract block recoverable
      // from the declared summary alone — derive outcome from needsHelp instead of
      // reading the runner's actual final assistant text (new transcript plumbing).
      outcome = lastOutcome?.needsHelp ? 'attention' : 'ok';
      summary = lastOutcome?.summary ?? '';
      links = [];
    }
    if (lastOutcome?.declaredState === 'blocked') outcome = 'failed';

    appendRunLog(def.dir, {
      start: run.started_at,
      end: new Date().toISOString(),
      outcome,
      summary,
      links,
      ...(proposedBriefChanges ? { proposedBriefChanges } : {}),
      attempt: run.attempt,
      terminalId,
    });

    agentsDb.updateRunStatus(this.db, run.id, outcome === 'failed' ? 'failed' : 'succeeded');
    this.sessionService.removeTerminal(terminalId);

    try {
      const scheduleRow = agentsDb.getSchedule(this.db, run.schedule_id);
      this.onRunFinalized?.(scheduleRow, agentsDb.getRun(this.db, run.id)!, outcome);
    } catch { /* the Task 7 seam must never break finalization */ }
  }
}
