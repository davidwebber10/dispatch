# Scheduled Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Durable, refinable role definitions (`~/.dispatch/roles/<name>/`) whose scheduled incarnations are fresh short-lived structured agents — with daemon supervision, per-role authority enforcement, and a morning digest — per `docs/superpowers/specs/2026-09-02-scheduled-roles-design.md`.

**Architecture:** Ride the existing `agent_schedules` scheduler + `agent_runs` telemetry. A role-backed schedule row (new nullable `role_name` column) makes `AgentService.runNow` take a new branch: spawn a STRUCTURED typed agent via `SessionService.createTerminal` + send the assembled seed as the first message (the same shape as agency-mcp's spawnAgent). Finalization/log-append hooks the existing `statusService.addThreadSettledListener`. Authority is a role variant of the v2.35.0 membrane policy, selected by `config.rolePolicy`. The digest is just a global role whose brief writes `digest.md` in an Operations project.

**Tech Stack:** TypeScript, vitest, better-sqlite3 (existing), no new dependencies.

## Global Constraints

- Never run the web vite build on a feature branch (`packages/web/dist` is served by the daemon). Web typecheck = `cd packages/web && npx tsc -b`.
- Commit trailers: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + `Claude-Session: https://claude.ai/code/session_013boLZzktkvJUpcDYJQCem8`.
- Stacked PRs: retarget each PR to main (`gh pr edit N --base main`) AFTER the one below merges, BEFORE merging it — never rely on delete-branch retargeting (see 2026-09-02 ledger lesson).
- Stop at "PRs open, CI green" — merges/releases are separate approvals.
- Spec invariants (verbatim): sessions are cattle, roles are pets; the runner never edits `role.md`; enabling is a deliberate per-machine act (pulling definitions must never start agents); **2 consecutive failed nights → auto-disable**; retry ONCE per fire; default wall cap 45 min; main/production mutations are explicit human approval only, always; v1 runners are claude-code only.
- Role frontmatter syntax (fixed here): flat `key: value` lines between `---` fences; a value is `JSON.parse`d when it starts with `{`, `[`, or `"`, or equals `true`/`false`/a number; otherwise it is the raw trimmed string. `schedule` must be valid JSON equal to an existing `recurrence_rule` shape (`{"type":"daily","time":"05:30"}`, weekly, cron, interval — see `packages/core/src/agents/recurrence.ts`).
- Branch stack: `feat/roles-core` (from main) → `feat/roles-lifecycle` → `feat/roles-digest-seeds`.

## File Structure

```
packages/core/src/roles/
  definition.ts        # parse role.md, list/validate role dirs (pure-ish; fs reads)
  definition.test.ts
  seed.ts              # assemble the incarnation seed message (pure)
  seed.test.ts
  role-policy.ts       # observe|stage|stage-deploy membrane policy (pure)
  role-policy.test.ts
  service.ts           # RolesService: discovery+enable/disable, run branch helpers,
                       # settled-listener finalization, retry/disable, wall-cap sweep
  service.test.ts
packages/core/src/routes/roles.ts        # GET /api/roles, POST /api/roles/:name/enable|disable
packages/core/src/db/schema.ts           # + role_name, consecutive_failures on agent_schedules; + attempt on agent_runs
packages/core/src/db/agents.ts           # + role helpers
packages/core/src/agents/service.ts      # runNow role branch delegation
packages/core/src/sessions/service.ts    # rolePolicy wiring beside coordinatorToolPolicy
packages/core/src/server.ts              # RolesService construction + wiring
packages/cli/src/index.ts                # `dispatch roles` subcommand group
docs/examples/roles/*/role.md            # the four seed briefs (Task 9)
```

---

## PR-1 — roles core (branch `feat/roles-core`)

### Task 1: Role definition loader

**Files:**
- Create: `packages/core/src/roles/definition.ts`
- Test: `packages/core/src/roles/definition.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RoleDefinition {
    name: string;            // dir name; must match frontmatter name if present
    dir: string;             // absolute role dir
    project: string | null;  // Dispatch project NAME to run in; null when global
    global: boolean;
    agentType: string;       // validated against ['planner','implementer','researcher','reviewer','design-reviewer','code-reviewer']
    model?: string;
    schedule: unknown;       // recurrence_rule JSON (validated by computeNextRunAt at enable time)
    tz?: string;
    authority: 'observe' | 'stage' | 'stage-deploy';   // default 'stage'
    wallClockCapMin: number; // default 45
    brief: string;           // body after frontmatter
  }
  export function parseRoleMd(name: string, dir: string, raw: string): RoleDefinition; // throws Error with a human message on invalid input
  export function rolesRootDir(): string;                     // ~/.dispatch/roles (overridable via DISPATCH_ROLES_DIR for tests)
  export function listRoles(root?: string): { roles: RoleDefinition[]; errors: { name: string; error: string }[] };
  export function readRoleMemory(dir: string): string;        // memory.md or ''
  export function readRunLogTail(dir: string, n: number): string[];  // last n raw JSONL lines of log.jsonl (no parse)
  export function appendRunLog(dir: string, entry: object): void;    // mkdir -p + append JSON line
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/src/roles/definition.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendRunLog, listRoles, parseRoleMd, readRunLogTail } from './definition.js';

const RAW = `---
name: rollup-nightly-check
project: shopify-product-rollup
agentType: researcher
model: sonnet
schedule: {"type":"daily","time":"05:30"}
tz: America/Indianapolis
authority: stage
wallClockCapMin: 30
---
Check last night's runs.`;

describe('parseRoleMd', () => {
  it('parses frontmatter + brief body', () => {
    const d = parseRoleMd('rollup-nightly-check', '/x', RAW);
    expect(d).toMatchObject({
      name: 'rollup-nightly-check', project: 'shopify-product-rollup', global: false,
      agentType: 'researcher', model: 'sonnet', tz: 'America/Indianapolis',
      authority: 'stage', wallClockCapMin: 30,
    });
    expect(d.schedule).toEqual({ type: 'daily', time: '05:30' });
    expect(d.brief).toBe("Check last night's runs.");
  });
  it('defaults: authority=stage, wallClockCapMin=45; global:true clears project', () => {
    const d = parseRoleMd('digest', '/x', '---\nglobal: true\nagentType: researcher\nschedule: {"type":"daily","time":"07:00"}\n---\nbody');
    expect(d.global).toBe(true);
    expect(d.project).toBeNull();
    expect(d.authority).toBe('stage');
    expect(d.wallClockCapMin).toBe(45);
  });
  it('rejects: missing schedule, unknown agentType, unknown authority, name mismatch', () => {
    expect(() => parseRoleMd('r', '/x', '---\nagentType: researcher\n---\nb')).toThrow(/schedule/);
    expect(() => parseRoleMd('r', '/x', '---\nagentType: wizard\nschedule: {"type":"manual"}\n---\nb')).toThrow(/agentType/);
    expect(() => parseRoleMd('r', '/x', '---\nagentType: researcher\nschedule: {"type":"manual"}\nauthority: yolo\n---\nb')).toThrow(/authority/);
    expect(() => parseRoleMd('r', '/x', '---\nname: other\nagentType: researcher\nschedule: {"type":"manual"}\n---\nb')).toThrow(/name/);
    expect(() => parseRoleMd('r', '/x', '---\nagentType: researcher\nschedule: {"type":"manual"}\nglobal: false\n---\nb')).toThrow(/project/); // non-global needs a project
  });
});

describe('listRoles / run log', () => {
  let tmp: string;
  afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });
  it('lists valid role dirs, collects errors for invalid ones, ignores non-dirs', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-'));
    fs.mkdirSync(path.join(tmp, 'good'));
    fs.writeFileSync(path.join(tmp, 'good', 'role.md'), RAW);
    fs.mkdirSync(path.join(tmp, 'bad'));
    fs.writeFileSync(path.join(tmp, 'bad', 'role.md'), 'no frontmatter');
    fs.writeFileSync(path.join(tmp, 'stray.txt'), 'x');
    const { roles, errors } = listRoles(tmp);
    expect(roles.map((r) => r.name)).toEqual(['good']);
    expect(errors).toHaveLength(1);
    expect(errors[0].name).toBe('bad');
  });
  it('appendRunLog + readRunLogTail round-trip, tail-limited', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-'));
    const dir = path.join(tmp, 'r');
    for (let i = 1; i <= 5; i++) appendRunLog(dir, { n: i });
    const tail = readRunLogTail(dir, 3).map((l) => JSON.parse(l).n);
    expect(tail).toEqual([3, 4, 5]);
    expect(readRunLogTail(path.join(tmp, 'none'), 3)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/core && npx vitest run src/roles/definition.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `definition.ts`**

```ts
// packages/core/src/roles/definition.ts
// Role definitions — the "pets" of the scheduled-roles design
// (docs/superpowers/specs/2026-09-02-scheduled-roles-design.md §1). A role lives at
// ~/.dispatch/roles/<name>/ as plain files so it is model-agnostic, git-backupable,
// and human-editable; the daemon re-reads role.md at every fire so edits are
// inherited by the next incarnation with no re-registration.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROLE_AGENT_TYPES = ['planner', 'implementer', 'researcher', 'reviewer', 'design-reviewer', 'code-reviewer'] as const;
export const ROLE_AUTHORITIES = ['observe', 'stage', 'stage-deploy'] as const;
export type RoleAuthority = (typeof ROLE_AUTHORITIES)[number];

export interface RoleDefinition {
  name: string;
  dir: string;
  project: string | null;
  global: boolean;
  agentType: string;
  model?: string;
  schedule: unknown;
  tz?: string;
  authority: RoleAuthority;
  wallClockCapMin: number;
  brief: string;
}

/** Flat frontmatter: `key: value`; JSON.parse when the value starts with {,[," or is a
 *  bool/number; else the raw trimmed string. Deliberately not YAML — the schema is flat
 *  and small, and a hand-rolled subset beats a dependency for four keys. */
function parseFrontmatter(raw: string): { fm: Record<string, unknown>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) throw new Error('role.md must start with a --- frontmatter block');
  const fm: Record<string, unknown> = {};
  for (const line of m[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i < 0) throw new Error(`frontmatter line has no colon: "${line}"`);
    const key = line.slice(0, i).trim();
    const rawVal = line.slice(i + 1).trim();
    if (/^[{["]/.test(rawVal)) {
      try { fm[key] = JSON.parse(rawVal); } catch { throw new Error(`frontmatter "${key}" is not valid JSON`); }
    } else if (rawVal === 'true' || rawVal === 'false') fm[key] = rawVal === 'true';
    else if (rawVal !== '' && !Number.isNaN(Number(rawVal))) fm[key] = Number(rawVal);
    else fm[key] = rawVal;
  }
  return { fm, body: m[2].trim() };
}

export function parseRoleMd(name: string, dir: string, raw: string): RoleDefinition {
  const { fm, body } = parseFrontmatter(raw);
  if (typeof fm.name === 'string' && fm.name !== name) throw new Error(`frontmatter name "${fm.name}" does not match dir name "${name}"`);
  const global = fm.global === true;
  const project = global ? null : typeof fm.project === 'string' && fm.project ? fm.project : null;
  if (!global && !project) throw new Error('a non-global role needs a project binding (or global: true)');
  const agentType = String(fm.agentType ?? '');
  if (!(ROLE_AGENT_TYPES as readonly string[]).includes(agentType)) throw new Error(`unknown agentType "${agentType}"`);
  if (fm.schedule === undefined) throw new Error('schedule is required');
  const authority = (fm.authority ?? 'stage') as RoleAuthority;
  if (!(ROLE_AUTHORITIES as readonly string[]).includes(authority)) throw new Error(`unknown authority "${String(fm.authority)}"`);
  const cap = typeof fm.wallClockCapMin === 'number' && fm.wallClockCapMin > 0 ? fm.wallClockCapMin : 45;
  return {
    name, dir, project, global, agentType,
    model: typeof fm.model === 'string' && fm.model ? fm.model : undefined,
    schedule: fm.schedule,
    tz: typeof fm.tz === 'string' && fm.tz ? fm.tz : undefined,
    authority, wallClockCapMin: cap, brief: body,
  };
}

export function rolesRootDir(): string {
  return process.env.DISPATCH_ROLES_DIR || path.join(os.homedir(), '.dispatch', 'roles');
}

export function listRoles(root: string = rolesRootDir()): { roles: RoleDefinition[]; errors: { name: string; error: string }[] } {
  const roles: RoleDefinition[] = [];
  const errors: { name: string; error: string }[] = [];
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return { roles, errors }; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    try {
      const raw = fs.readFileSync(path.join(dir, 'role.md'), 'utf8');
      roles.push(parseRoleMd(e.name, dir, raw));
    } catch (err) {
      errors.push({ name: e.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  roles.sort((a, b) => a.name.localeCompare(b.name));
  return { roles, errors };
}

export function readRoleMemory(dir: string): string {
  try { return fs.readFileSync(path.join(dir, 'memory.md'), 'utf8'); } catch { return ''; }
}

export function readRunLogTail(dir: string, n: number): string[] {
  try {
    const lines = fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n);
  } catch { return []; }
}

export function appendRunLog(dir: string, entry: object): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify(entry) + '\n');
}
```

- [ ] **Step 4: Run to verify pass** — same command, expect all green.
- [ ] **Step 5: Commit** — `feat(roles): role.md definition loader + run log helpers`

### Task 2: DB columns + role schedule helpers

**Files:**
- Modify: `packages/core/src/db/schema.ts` (append to the ad-hoc column-add migration list at ~lines 220-232)
- Modify: `packages/core/src/db/agents.ts`
- Test: extend `packages/core/src/db/agents.test.ts` if it exists; else create minimal `packages/core/src/db/agents-roles.test.ts` using the same in-memory-DB pattern as neighboring db tests.

**Interfaces:**
- Produces: `agent_schedules` gains `role_name TEXT` (null = ordinary schedule) and `consecutive_failures INTEGER NOT NULL DEFAULT 0`; `agent_runs` gains `attempt INTEGER NOT NULL DEFAULT 1`. `db/agents.ts` gains:
  ```ts
  export function getScheduleByRoleName(db: Database, roleName: string): AgentScheduleRow | undefined;
  export function setConsecutiveFailures(db: Database, scheduleId: string, n: number): void;
  ```
  and `createRun` accepts an optional `attempt` (defaults 1); `AgentScheduleRow`/`AgentRunRow` types extended accordingly.

- [ ] **Step 1: Failing test** — in-memory DB: create a schedule with `role_name: 'x'`, assert `getScheduleByRoleName` finds it; `setConsecutiveFailures(db, id, 2)` round-trips; `createRun(..., { attempt: 2 })` persists `attempt = 2` (copy the construction/insert helper style from the existing db test files — read one first).
- [ ] **Step 2: Verify failure** (`npx vitest run` on the new test).
- [ ] **Step 3: Implement** — add the three columns to the migration list exactly like the existing telemetry-column adds at schema.ts:223-231 (e.g. `['agent_schedules','role_name','TEXT'], ['agent_schedules','consecutive_failures','INTEGER NOT NULL DEFAULT 0'], ['agent_runs','attempt','INTEGER NOT NULL DEFAULT 1']`); extend the row types + insert/select column lists in `db/agents.ts`; add the two helpers beside `getSchedule`/`updateSchedule`.
- [ ] **Step 4: Verify pass + full core suite** (`npx vitest run`).
- [ ] **Step 5: Commit** — `feat(roles): role-backed schedule + attempt columns and helpers`

### Task 3: RolesService discovery/enable/disable + routes

**Files:**
- Create: `packages/core/src/roles/service.ts` (+ `service.test.ts`)
- Create: `packages/core/src/routes/roles.ts`
- Modify: `packages/core/src/server.ts` (construct RolesService beside AgentService ~line 558; mount routes where the other routers mount)

**Interfaces:**
- Produces:
  ```ts
  export interface RoleStatusEntry {
    def: RoleDefinition;
    enabled: boolean;
    scheduleId?: string;
    nextRunAt?: string | null;
    consecutiveFailures?: number;
    error?: string;            // parse errors surface as disabled entries with error
  }
  export class RolesService {
    constructor(deps: { db: Database; agentService: AgentService; sessionService: SessionService; rolesRoot?: string });
    list(): RoleStatusEntry[];                       // scan dir + merge schedule state by role_name
    enable(name: string): RoleStatusEntry;           // upsert agent_schedules row from frontmatter; throws if project not found (global → ensureOperationsProject)
    disable(name: string): RoleStatusEntry;          // enabled=0 (row kept: preserves failure history)
    ensureOperationsProject(): Session;              // find-by-name 'Operations' else SessionService.create({ name:'Operations', workingDir: path.join(os.homedir(),'.dispatch','operations') })
  }
  ```
  Routes: `GET /api/roles` → `{ roles: RoleStatusEntry[] }` (defs serialized without `brief` body — keep the payload light, the CLI reads files directly if it wants content); `POST /api/roles/:name/enable` / `:name/disable` → the updated entry; 404 on unknown name, 400 with the parse/validation message on invalid.
- Consumes: Task 1 loader; Task 2 helpers; `AgentService.createSchedule/updateSchedule` (agents/service.ts:200,216 — reuse so `next_run_at` is computed by the existing `withComputedNextRun`); `SessionService.create` (sessions/service.ts:292) + `list` for project lookup by name.

- [ ] **Step 1: Failing tests** — with `DISPATCH_ROLES_DIR` pointed at a tmp dir containing one valid role bound to a project name that exists in an in-memory DB session fixture: `list()` shows `enabled:false`; `enable('x')` creates a schedule row with `role_name='x'`, `prompt:''`, `provider:'claude-code'`, recurrence from frontmatter, and `list()` now shows `enabled:true` with a `nextRunAt`; `disable('x')` flips enabled off but keeps the row; `enable('missing')` throws; a global role enable creates/uses the Operations project. Follow the service-test pattern used by existing core service tests (in-memory DB + a stub SessionService with just the methods used).
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement** service + routes + server wiring (RolesService constructed after agentService; router mounted beside the agents router).
- [ ] **Step 4: Verify pass + full core suite.**
- [ ] **Step 5: Commit** — `feat(roles): discovery + enable/disable service and /api/roles routes`

### Task 4: CLI `dispatch roles` group + PR-1

**Files:**
- Modify: `packages/cli/src/index.ts` (switch at :42-88, usage at :85)
- Test: extend the CLI tests in `packages/cli/` following the existing command-test pattern (read one first).

**Interfaces:**
- Produces: `dispatch roles list` (table: name · project/global · enabled · next run · consecutive failures · errors), `dispatch roles enable <name>`, `dispatch roles disable <name>`. Implementation: HTTP against the local daemon (`http://localhost:${PORT||3456}/api/roles...`) — mirror how other CLI commands reach the daemon; if none does HTTP yet, use plain `fetch` with a clear "daemon not running" error on ECONNREFUSED.

- [ ] Steps: failing CLI test (mock/stub the fetch seam like existing tests stub `ctx` seams) → implement `cmdRoles(ctx, rest)` beside `cmdTools:147` → green → full cli tests → commit `feat(cli): dispatch roles list/enable/disable` → **push branch, open PR-1** (`feat/roles-core`, base main).

---

## PR-2 — run lifecycle, supervision, authority (branch `feat/roles-lifecycle`, from PR-1)

### Task 5: Seed assembly (pure)

**Files:**
- Create: `packages/core/src/roles/seed.ts` (+ `seed.test.ts`)

**Interfaces:**
- Produces:
  ```ts
  export function buildSeedMessage(input: {
    def: RoleDefinition;         // Task 1 type
    memory: string;              // readRoleMemory
    logTail: string[];           // readRunLogTail(dir, 3)
    nowIso: string;              // injected — no Date.now inside (pure)
  }): string;
  ```
  The message contains, in order: a header naming the role + `nowIso` + the freshness instruction ("verify the world before acting — fetch, check branch/data state; trust nothing remembered"); the authority rules text for `def.authority` (observe: report only / stage: branches+PRs, never merge/deploy/main / stage-deploy: + explicit staging forms only); the brief body; `## Role memory` + memory (omitted when empty); `## Recent run reports` + the tail lines (omitted when empty); and the output contract: end with report_status AND a final message containing a fenced ```json block `{ "outcome": "ok"|"attention"|"failed", "summary": "...", "links": [...], "proposedBriefChanges": "..."? }` — the daemon parses this block into the run log (Task 6).

- [ ] Steps: failing tests (header contains nowIso + role name; authority text varies by level; empty memory/log sections omitted; contract block always present) → implement → green → commit `feat(roles): incarnation seed assembly`.

### Task 6: Role run branch — spawn, finalize, log append

**Files:**
- Modify: `packages/core/src/agents/service.ts` (`runNow` at :322 — role branch)
- Modify: `packages/core/src/roles/service.ts` (+ `spawnRoleRun`, `finalizeRoleRun`, settled-listener subscription)
- Modify: `packages/core/src/server.ts` (pass statusService into RolesService wiring; subscribe)
- Test: extend `packages/core/src/roles/service.test.ts`

**Interfaces:**
- Consumes: `SessionService.createTerminal(sessionId, 'claude-code', label, true, workingDir?, undefined, config)` (sessions/service.ts:413) + `sendThreadMessage(terminalId, seed, 'coordinator')` (:990); `statusService.addThreadSettledListener` (the same hook `push/notify.ts:12` uses — read it first and mirror the subscription shape); `config.lastOutcome` written by `noteTurnOutcome` (sessions/service.ts:1300); `interrupt` (:1467); `removeTerminal` (:1745) to archive the finished runner.
- Produces:
  - `AgentService.runNow`: when the schedule row has `role_name`, delegate to `rolesService.spawnRoleRun(schedule, run)` instead of `createRunnerTerminal` (inject RolesService via an optional setter to avoid a constructor cycle: `agentService.setRoleRunner(rolesService)`).
  - `spawnRoleRun`: re-read + re-parse `role.md` (fires use CURRENT definition); resolve the project (by name / Operations for global); `createTerminal` with config `{ transport:'structured', role:'agent', agentType, model?, mission: def.name, roleRun: def.name, roleAuthority: def.authority, spawnDepth: 1 }`, label `` `${def.name} · ${date}` ``; send the seed (Task 5) via `sendThreadMessage(..., 'coordinator')`; `attachTerminal(run, terminalId)`, `updateRunStatus('working')`.
  - Settled listener: for terminals whose `config.roleRun` is set — read `config.lastOutcome`, parse the final ```json contract block out of the runner's last assistant text IF the conversation API exposes it cheaply, else fall back to `lastOutcome.summary` (`outcome: lastOutcome.needsHelp ? 'attention' : 'ok'`); `appendRunLog(def.dir, { start, end, outcome, summary, links, proposedBriefChanges, attempt, terminalId })`; `updateRunStatus(run, outcome==='failed' ? 'failed' : 'succeeded')`; archive the runner (`removeTerminal`); then Task 7's supervision hook.
- **Simplification permitted:** parsing the contract block from `lastOutcome.summary` alone (report_status summary ≤400 chars) is acceptable for v1 if extracting the final assistant text requires new plumbing — note the choice in the commit message. Do NOT add new transcript-reading machinery.

- [ ] Steps: failing service tests with stubbed SessionService (spawn call shape: config keys exactly as above; seed sent; settled → log line appended with attempt + outcome; runner archived) → implement → green → full core suite → commit `feat(roles): role-backed schedules spawn structured incarnations; settled runs append the log`.

### Task 7: Supervision — retry once, 2-night disable, wall cap

**Files:**
- Modify: `packages/core/src/roles/service.ts` (+ tests)
- Modify: `packages/core/src/agents/service.ts` (`processDueRuns` tick :365 — call `rolesService.sweepWallCap(now)`)

**Interfaces:**
- Produces, all on RolesService:
  - failure path in the settled/finalize flow: attempt 1 failed → immediately `spawnRoleRun(schedule, createRun(..., { attempt: 2 }))`; attempt 2 failed → `setConsecutiveFailures(n+1)`; success (any attempt) → `setConsecutiveFailures(0)`.
  - `consecutive_failures >= 2` → `updateSchedule(enabled: 0)` + `pushService.notifyThread({ terminalId: <runner terminal>, sessionId, title: 'Role disabled: <name>', body: '2 consecutive failed nights — re-enable with dispatch roles enable <name>' })` (PushService.notifyThread — push/service.ts:66; RolesService takes pushService as an optional dep, no-op when absent).
  - `sweepWallCap(nowIso)`: role runs in status `working`/`starting` whose `started_at` is older than the def's `wallClockCapMin` → `sessionService.interrupt(terminalId)`, `updateRunStatus('failed', { error: 'wall-clock cap' })`, then the same failure path (retry/disable).
- Consumes: Task 2 helpers, Task 6 spawn/finalize, `PushService.notifyThread`.

- [ ] Steps: failing tests (attempt-1 failure respawns with attempt 2; attempt-2 failure increments consecutive_failures; second bad night disables + pushes; success resets the counter; wall-cap sweep interrupts + fails an overdue run and leaves a fresh one alone) → implement → green → full core suite → commit `feat(roles): retry-once, 2-night auto-disable, wall-clock cap`.

### Task 8: Role authority policy + membrane wiring + PR-2

**Files:**
- Create: `packages/core/src/roles/role-policy.ts` (+ `role-policy.test.ts`)
- Modify: `packages/core/src/sessions/service.ts` (`spawnStructured` toolPolicy wiring at ~:1990 — extend the coordinator-only line)

**Interfaces:**
- Produces:
  ```ts
  export function roleToolPolicy(authority: 'observe' | 'stage' | 'stage-deploy'):
    (toolName: string, input: unknown) => { allow: true } | { allow: false; message: string };
  ```
  Rules (deny messages name what to do instead, mirroring `coordinator-policy.ts`):
  - all levels deny: bare `git push` (no explicit refspec — require `git push <remote> <branch>`), explicit push where the branch matches `/^(main|master|prod)/`, ALL `gh pr merge`, `gh workflow run` containing `environment=production` or lacking `environment=staging` (deny-when-ambiguous), `gh release`, `(npm|pnpm|yarn) publish`, `dispatch (update|release)`, `terraform (apply|destroy)`, native `Agent`/`Task`.
  - `observe`: additionally deny ALL file writes (`Write`/`Edit`/`MultiEdit`/`NotebookEdit`) and `git commit`/all `git push`/`gh pr create`.
  - `stage`: file writes allowed anywhere in the project; `git commit`, explicit non-protected `git push`, `gh pr create` allowed; `gh workflow run` denied entirely.
  - `stage-deploy`: `stage` + `gh workflow run … environment=staging` allowed (flag-tolerant regex, same `(?:-\S+\s+)*` technique as coordinator-policy — read that file first and reuse its style).
  Wiring: `const toolPolicy = config.role === 'coordinator' ? coordinatorToolPolicy : typeof config.roleAuthority === 'string' ? roleToolPolicy(config.roleAuthority as never) : undefined;`
- [ ] Steps: failing policy tests (per level: the allow/deny matrix above, incl. `git push origin stage` allowed at stage, `git push origin main` denied, `gh workflow run deploy.yml -f environment=staging` allowed only at stage-deploy, ambiguous `gh workflow run deploy.yml` denied everywhere, observe denies Edit) → implement → green → wiring + a service-level assertion if cheap → full core suite + `npx tsc --noEmit` → commit `feat(roles): per-role authority policy enforced at the membrane` → **push, open PR-2** (base `feat/roles-core`).

---

## PR-3 — digest + seed briefs (branch `feat/roles-digest-seeds`, from PR-2)

### Task 9: Seed role briefs (examples) + digest push

**Files:**
- Create: `docs/examples/roles/rollup-nightly-check/role.md`, `docs/examples/roles/legacy-repo-chores/role.md`, `docs/examples/roles/ci-pr-babysitter/role.md`, `docs/examples/roles/morning-digest/role.md`
- Modify: `packages/core/src/roles/service.ts` — after a `morning-digest` role run finalizes successfully, send the push headline: `pushService.notifyThread({ terminalId, sessionId, title: 'Daily Digest', body: firstLine(summary) })` (+ test).

Brief contents (write in full — these are the product; each ends with the §5-appropriate output contract and the digest-file instruction where relevant):
1. **rollup-nightly-check** (`project: shopify-product-rollup`, researcher, sonnet, `stage`, 05:30): check last night's delta-sync + OIC runs (the brief lists the exact log locations/commands Jason's transcripts used — the implementer should copy the "Check last night's run" task text patterns from `docs/superpowers/plans/2026-09-02-overseer-tuning.md`'s analysis notes as the starting recipe); diagnose failures; a diagnosed failure MAY arrive as a staged fix branch + `gh pr create` PR; never merge/deploy/re-run production jobs; report contract block.
2. **legacy-repo-chores** (`project: PW Legacy`, implementer, sonnet, `stage`, daily 06:00): commit uncommitted work in the legacy repo with sensible messages, tidy stray files per the repo's own conventions; never push anywhere but the working branch; report.
3. **ci-pr-babysitter** (`global: true`, researcher, sonnet, `observe`, every 4h interval): list open PRs across the known repos (`gh pr list` per repo listed in the brief), report failing/stalled checks + PRs idle >24h; observe-only.
4. **morning-digest** (`global: true`, researcher, sonnet, `observe`, daily 07:00): read every `~/.dispatch/roles/*/log.jsonl` latest entries + `GET /api/sessions` + each coordinator's `config.lastOutcome` via the API; write the summary to `~/.dispatch/operations/digest.md` (NEWEST ENTRY ON TOP, dated headers) — the file IS the deliverable; lead with failures, staged-work-awaiting-review, and proposed brief changes; suppress "nothing happened" noise; the daemon sends the push headline.

- [ ] Steps: write briefs → the digest-push failing test → implement → green → commit `feat(roles): four seed role briefs + digest push headline`.

### Task 10: Digest file tab + docs + PR-3

**Files:**
- Modify: `packages/core/src/roles/service.ts` — `ensureOperationsProject()` also ensures a `file` terminal for `digest.md` exists in Operations (find `t.type==='file' && config.path===<digest path>` else `createTerminal(sessionId,'file','digest.md',false,undefined,undefined,{ path })`; + test).
- Create: `docs/releases/` entry is NOT written here (release is a separate approval); instead add `docs/roles.md` — a short operator guide: role.md format (copy the Global Constraints syntax section), enable/disable CLI, where logs live, how proposals are applied (deliberate-manual, per spec), the authority levels table.

- [ ] Steps: failing ensure-file-tab test → implement → green → full core suite + web typecheck (`cd packages/web && npx tsc -b` — web is untouched but the gate is cheap) → write `docs/roles.md` → commit `feat(roles): Operations digest file tab + operator docs` → **push, open PR-3** (base `feat/roles-lifecycle`).

### Task 11: Final verification

- [ ] Full suites on the PR-3 branch: `cd packages/core && npx vitest run` and `cd packages/web && npx vitest run && npx tsc -b`. Known flakes (pass in isolation): tests/routes/auth.test.ts ECONNRESET; ThreadLabel typewriter; AnalyticsView; NewThreadModal waitFor.
- [ ] Final whole-branch review (subagent-driven flow: `scripts/review-package $(git merge-base main HEAD) HEAD`, most capable model) with special attention to: the settled-listener race (a role run settling during daemon shutdown), the retry loop terminating (attempt ≤ 2 enforced), `roleAuthority` never applying to non-role threads, and the enable path never auto-starting anything at discovery time.
- [ ] Report: 3 PRs open + CI status. Merge order on approval: PR-1 → retarget PR-2 to main → merge PR-2 → retarget PR-3 → merge PR-3. Suggested release: minor (roles are a new capability). Release note must state: definitions are files, enabling is per-machine, v1 runners are claude-code only, and the daemon must be updated + restarted for the scheduler branch to exist.
