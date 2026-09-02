// RolesService — discovery + enable/disable for scheduled roles (the "pets" of the
// scheduled-roles design; docs/superpowers/specs/2026-09-02-scheduled-roles-design.md §1).
// Discovery (list()) only ever reads the roles directory and the DB; it never creates or
// starts anything. enable()/disable() are the only mutating entry points, and they are a
// deliberate per-machine act — never triggered implicitly by discovery.
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { listRoles, rolesRootDir, type RoleDefinition } from './definition.js';
import * as agentsDb from '../db/agents.js';
import type { AgentService } from '../agents/service.js';
import type { SessionService } from '../sessions/service.js';
import type { Session } from '../types.js';

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

export class RolesService {
  private db: Database.Database;
  private agentService: AgentService;
  private sessionService: SessionService;
  private rolesRoot: string;

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
}
