// RolesService — discovery + enable/disable for scheduled roles (the "pets" of the
// scheduled-roles design; docs/superpowers/specs/2026-09-02-scheduled-roles-design.md §1).
// Discovery (list()) only ever reads the roles directory and the DB; it never creates or
// starts anything. enable()/disable() are the only mutating entry points, and they are a
// deliberate per-machine act — never triggered implicitly by discovery.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { appendRunLog, listRoles, readRoleMemory, readRunLogTail, rolesRootDir, type RoleDefinition } from './definition.js';
import { buildSeedMessage } from './seed.js';
import * as agentsDb from '../db/agents.js';
import * as terminalsDb from '../db/terminals.js';
import type { AgentService, RoleRunner } from '../agents/service.js';
import type { SessionService } from '../sessions/service.js';
import type { StatusService } from '../status/service.js';
import type { PushService } from '../push/service.js';
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
  /** Working dir for the shared Operations project (global roles + the digest.md file
   *  tab, Task 10). Defaults to ~/.dispatch/operations; overridable — mirroring
   *  rolesRoot above — so tests don't write a real digest.md under a developer's
   *  actual home directory. */
  operationsDir?: string;
  /** Optional (Task 7): backs the 2-consecutive-failed-nights auto-disable push. A no-op
   *  when absent — supervision (retry/counter/disable) still runs without it, it just
   *  can't raise the Needs-you. */
  pushService?: Pick<PushService, 'notifyThread'>;
}

const OPERATIONS_PROJECT_NAME = 'Operations';

/** Name of the shared morning-digest deliverable's file tab within the Operations
 *  project — see ensureDigestFileTab below. */
const DIGEST_FILE_NAME = 'digest.md';

/** The one role whose successful run raises a push (spec §4): the digest IS the deliverable
 *  file, but a human still needs a tap-through to know a new one landed. */
const DIGEST_ROLE_NAME = 'morning-digest';

/** The push body is a headline, not the whole report — the first line of the run's own
 *  summary (the contract's "one paragraph of what happened"), trimmed. */
function firstLine(summary: string): string {
  return (summary.split('\n')[0] ?? '').trim();
}

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
  private operationsDir: string;
  private pushService?: Pick<PushService, 'notifyThread'>;

  constructor(deps: RolesServiceDeps) {
    this.db = deps.db;
    this.agentService = deps.agentService;
    this.sessionService = deps.sessionService;
    this.rolesRoot = deps.rolesRoot ?? rolesRootDir();
    this.operationsDir = deps.operationsDir ?? path.join(os.homedir(), '.dispatch', 'operations');
    this.pushService = deps.pushService;
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
   *  against a dedicated ~/.dispatch/operations workspace, not a per-role directory).
   *  Also ensures the digest.md file tab (Task 10) — every call, not just creation,
   *  so an Operations project from before Task 10 still gets the tab retrofitted. */
  ensureOperationsProject(): Session {
    const existing = this.sessionService.list().find((s) => s.name === OPERATIONS_PROJECT_NAME);
    const project = existing ?? this.sessionService.create({
      provider: 'claude-code',
      name: OPERATIONS_PROJECT_NAME,
      workingDir: this.operationsDir,
    });
    this.ensureDigestFileTab(project);
    return project;
  }

  /** Find-or-create the pinned FILES tab for digest.md in the Operations project, so the
   *  digest is one tap away even before the morning-digest role's first run writes it.
   *  Idempotent: matched the same way the web client dedupes file tabs (openFileTab.ts,
   *  FilesPane.tsx) — `t.type === 'file' && config.path === <digest path>`. A missing
   *  digest.md 400s the /read route (routes/files.ts's resolveRead + readFileSync), so a
   *  placeholder is written the first time only — a real run's content is never clobbered. */
  private ensureDigestFileTab(project: Session): void {
    const digestPath = path.join(this.operationsDir, DIGEST_FILE_NAME);
    const tabs = this.sessionService.listTerminals(project.id);
    const hasTab = tabs.some((t) => t.type === 'file' && (t.config as { path?: string } | undefined)?.path === digestPath);
    if (hasTab) return;

    if (!fs.existsSync(digestPath)) {
      fs.mkdirSync(path.dirname(digestPath), { recursive: true });
      fs.writeFileSync(digestPath, '# Daily Digest\n');
    }
    this.sessionService.createTab(project.id, 'file', DIGEST_FILE_NAME, { path: digestPath });
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

    this.closeOutRun(terminalId, roleName, run, outcome, summary, links, proposedBriefChanges);
  }

  /**
   * Shared close-out tail once a role-run incarnation's outcome is known: append the
   * log.jsonl line, settle the run row, archive the runner terminal, and route the
   * result through Task 7's retry/2-night-disable supervision. Used by both the normal
   * settled path (finalizeRoleRun, above) and the crash path (handleTerminalExit, below)
   * so a runner that dies mid-turn is held to the exact same bookkeeping as one that
   * settles cleanly — same log line, same failure counting, same terminal archiving.
   */
  private closeOutRun(
    terminalId: string,
    roleName: string,
    run: agentsDb.AgentRunRow,
    outcome: RunOutcome,
    summary: string,
    links: string[],
    proposedBriefChanges?: string,
  ): void {
    // The role may have been edited or deleted since this incarnation spawned; fall back
    // to a stub with the same directory (errorStub) so the report still lands somewhere.
    const { roles } = listRoles(this.rolesRoot);
    const def = roles.find((r) => r.name === roleName) ?? errorStub(this.rolesRoot, roleName);

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
    try { this.sessionService.removeTerminal(terminalId); } catch { /* best effort — may already be gone on the crash path */ }

    // Spec §4: a successful morning-digest run pushes its headline (the file itself is the
    // deliverable; this is just the tap-through nudge). Best-effort, same as every other push
    // in this file — a notification failure must never break run finalization.
    if (roleName === DIGEST_ROLE_NAME && outcome === 'ok') {
      this.pushService?.notifyThread({
        terminalId,
        sessionId: run.project_id,
        title: 'Daily Digest',
        body: firstLine(summary),
      }).catch(() => { /* best-effort */ });
    }

    try {
      const scheduleRow = agentsDb.getSchedule(this.db, run.schedule_id);
      this.superviseFinalizedRun(scheduleRow, agentsDb.getRun(this.db, run.id)!, outcome);
    } catch { /* supervision must never break finalization */ }
  }

  /**
   * Mirrors AgentService.handleTerminalExit for the structured-transport role-run path,
   * which that method never sees: role runs are spawned via createTerminal (structured
   * transport), not createRunnerTerminal (the plain-PTY runner path handleTerminalExit
   * closes out), so server.ts's structured-manager exit handler previously left a
   * crashed role runner stuck 'working'/'starting' forever — no log line, no failure
   * counting, terminal never archived (Task 6 review finding, escalated to Critical for
   * Task 7). Wired from that same handler (server.ts) so a runner that crashes or whose
   * CLI process dies still finalizes as a failed attempt, feeding the identical
   * retry/2-night-disable supervision a clean settle uses.
   *
   * No-ops for a terminal that isn't a role run, or whose run already reached a terminal
   * state — the normal settled path got there first. That's not just a double-finalize
   * guard: on a CLEAN completion, closeOutRun's own `removeTerminal` call is what kills
   * the process and triggers this exact exit event, so without the guard every ordinary
   * settle would double-count itself as a second, spurious "crash".
   */
  handleTerminalExit(terminalId: string): void {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return;
    let config: Record<string, any> = {};
    try { config = JSON.parse(terminal.config || '{}'); } catch { /* malformed → not a role run */ }
    const roleName = config.roleRun;
    if (typeof roleName !== 'string' || !roleName) return;

    const run = agentsDb.getRunByTerminalId(this.db, terminalId);
    if (!run) return;
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') return;

    this.closeOutRun(terminalId, roleName, run, 'failed', 'runner process exited unexpectedly', []);
  }

  /**
   * Task 7: any role run still 'working'/'starting' past its role's wallClockCapMin
   * (default 45, spec §3) gets interrupted and failed here, then routed through the
   * exact same retry/2-night-disable supervision as an ordinary settled failure — a
   * role never runs forever just because nothing else failed it out. A run still under
   * its cap (a "fresh" run) is left untouched.
   *
   * Routes through the same `closeOutRun` tail every other finalization uses — NOT a
   * bare `updateRunStatus` — so a wall-cap timeout gets the exact same log.jsonl line
   * (the digest, and the retry's own seed via `readRunLogTail`, both read it), the same
   * terminal archiving (no zombie left in the rail), and the same double-finalize guard
   * (a late settle on the now-already-failed run can't double-fire).
   *
   * Falls back to `created_at` when `started_at` is NULL — a run can be persisted
   * 'starting' with no `started_at` yet if the daemon is hard-killed between `createRun`
   * and the `updateRunStatus('starting', ...)` that sets it; without the fallback such a
   * run's NULL `started_at` would never age past the cap, and `listDueSchedules` (which
   * treats any 'starting' run as still in flight) would block that schedule forever.
   */
  sweepWallCap(nowIso: string): void {
    const now = new Date(nowIso).getTime();
    for (const run of agentsDb.listActiveRoleRuns(this.db)) {
      const referenceIso = run.started_at ?? run.created_at;
      const schedule = agentsDb.getSchedule(this.db, run.schedule_id);
      const roleName = schedule?.role_name;
      if (!schedule || !roleName) continue;

      const { roles } = listRoles(this.rolesRoot);
      const def = roles.find((r) => r.name === roleName);
      const capMs = (def?.wallClockCapMin ?? 45) * 60_000;
      if (now - new Date(referenceIso).getTime() < capMs) continue;

      if (run.terminal_id) {
        try { this.sessionService.interrupt(run.terminal_id); } catch { /* best effort */ }
      }
      this.closeOutRun(run.terminal_id ?? '', roleName, run, 'failed', 'wall-clock cap', []);
    }
  }

  /**
   * Task 7 supervision, hung off every finalized role-run incarnation (both the settled
   * path and the wall-cap sweep route through this, via closeOutRun/sweepWallCap). A
   * first-attempt (attempt 1) failure spawns one fresh retry (attempt 2) immediately;
   * a second failure that night (attempt 2, or a retry spawn that itself throws) bumps
   * `consecutive_failures` and, once it reaches 2, disables the schedule and raises a
   * push Needs-you. Any success, at either attempt, resets the counter to 0. Bounded:
   * only `attempt <= 1` ever spawns a retry, so a failing attempt-2 run can never spawn
   * attempt 3.
   */
  private superviseFinalizedRun(schedule: agentsDb.AgentScheduleRow | null, run: agentsDb.AgentRunRow, outcome: RunOutcome): void {
    if (!schedule) return; // schedule deleted mid-flight — nothing left to supervise
    if (outcome !== 'failed') {
      agentsDb.setConsecutiveFailures(this.db, schedule.id, 0);
      return;
    }

    if (run.attempt <= 1) {
      const retry = agentsDb.createRun(this.db, {
        id: uuid(),
        scheduleId: schedule.id,
        projectId: schedule.project_id,
        terminalId: null,
        provider: schedule.provider,
        promptSnapshot: schedule.prompt,
        status: 'starting',
        error: null,
        externalSessionId: null,
        attempt: 2,
      });
      try {
        this.spawnRoleRun(schedule, retry);
        return; // attempt 2 is now live; ITS eventual settle re-enters this method
      } catch (err: any) {
        // The retry never even got a terminal — that's attempt 2's failure, right now.
        // Count it against the retry row (not the original attempt-1 run) so a push's
        // terminalId always points at the attempt that actually failed.
        const failedRetry = agentsDb.updateRunStatus(this.db, retry.id, 'failed', { error: err?.message ?? String(err) }) ?? retry;
        this.recordScheduleFailure(schedule, failedRetry);
        return;
      }
    }

    this.recordScheduleFailure(schedule, run);
  }

  /** consecutive_failures += 1; at >= 2, disable the schedule and (if a pushService is
   *  configured) raise the "re-enable with dispatch roles enable <name>" Needs-you. */
  private recordScheduleFailure(schedule: agentsDb.AgentScheduleRow, run: agentsDb.AgentRunRow): void {
    const n = schedule.consecutive_failures + 1;
    agentsDb.setConsecutiveFailures(this.db, schedule.id, n);
    if (n < 2) return;

    this.agentService.updateSchedule(schedule.id, { enabled: false });
    const name = schedule.role_name ?? schedule.name;
    // Best-effort: a push failure (e.g. the DB closing mid-shutdown, throwing before
    // notifyThread's own internal per-subscription try/catch even starts) must not
    // become an unhandled rejection — nothing here awaits this call, so an uncaught
    // throw would escape every caller's try/catch.
    this.pushService?.notifyThread({
      terminalId: run.terminal_id ?? '',
      sessionId: schedule.project_id,
      title: `Role disabled: ${name}`,
      body: `2 consecutive failed nights — re-enable with dispatch roles enable ${name}`,
    }).catch(() => { /* best-effort */ });
  }
}
