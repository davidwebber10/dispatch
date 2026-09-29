# Control Plane Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Usage | Control Plane` view switch to the Analytics screen, and a Control Plane view with sessions, missions, agents, review gates, token share, and messages by project.

**Architecture:** One core module (`analytics/control-plane.ts`) owns every definition and returns one payload from `GET /api/analytics/control-plane`. It loads coordinators and agents from one `terminals` scan and computes missions (rule B) in TypeScript. Token, day, and message sums stay in SQL. On the web, `AnalyticsView.tsx` becomes a shell (title, switch, shared filters). The current body moves unchanged into `UsageAnalytics.tsx`, and the new view is `ControlPlaneAnalytics.tsx`.

**Tech Stack:** TypeScript, better-sqlite3, Express, vitest + supertest (core); React 18, Recharts, zustand, vitest + Testing Library + jsdom (web).

**Spec:** `docs/superpowers/specs/2026-09-29-control-plane-analytics-design.md`. The layout reference is `docs/superpowers/specs/2026-09-29-control-plane-analytics-mockups.html` (Variant 1).

## Global Constraints

- Branch: `feat/control-plane-analytics` (it exists; the spec is committed there).
- Never build into `packages/core/dist`: the live daemon runs from it. A verify build goes to `packages/core/.verify/dist`.
- Never run `vite build` or `pnpm build` for verify work. Use `vitest`, `tsc --noEmit`, and the Vite dev server.
- Run vitest from inside the package (`cd packages/core && npx vitest run …`, `cd packages/web && npx vitest run …`). From the repo root, web tests fail without their jsdom config.
- Core tests that bucket days set `process.env.TZ = 'UTC'` on the first line, before any import.
- Days are local days (`date(x, 'localtime')` in SQL, `getFullYear/getMonth/getDate` in JS). Weeks start on Monday.
- Rule B: a mission is completed when no agent has status `working` or `queued` and its last activity is more than 7 days (`7 * 24 * 60 * 60 * 1000` ms) before now. Exactly 7 days is still active.
- Chart colors come only from `chartTheme.ts`: implementer `SERIES[0]` (`#3987e5`), researcher `SERIES[1]` (`#d95926`), planner `SERIES[3]` (`#c98500`), review `SERIES[2]` (`#199e70`), Control Plane `SERIES[4]` (`#d55181`), neutral `OTHER` (`#6b6b73`). No new hue.
- The localStorage key for the last view is `dispatch:analytics-view`. Values: `usage`, `control-plane`. A first visit opens Usage.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Do not push, merge, or deploy. The owner approves each of those separately.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `packages/core/src/analytics/control-plane-types.ts` | Create | The payload types. No imports, so the web can import it. |
| `packages/core/src/analytics/control-plane.ts` | Create | Definitions, rule B, scope load, summary, series, tables, assembler. |
| `packages/core/src/analytics/control-plane.test.ts` | Create | Core tests over an in-memory DB. |
| `packages/core/src/routes/analytics.ts` | Modify | Add `GET /control-plane`. |
| `packages/core/src/routes/analytics.test.ts` | Modify | Route test. |
| `packages/web/src/components/analytics/parts.tsx` | Create | Shared styles, formatters, `Kpi`, `Block`, `NoData`, `chartTooltip`. |
| `packages/web/src/components/analytics/parts.test.tsx` | Create | `Kpi` caption and info tests. |
| `packages/web/src/api/types.ts` | Modify | Re-export the payload types from core. |
| `packages/web/src/api/client.ts` | Modify | `api.analyticsControlPlane`. |
| `packages/web/src/components/analytics/controlPlaneFixture.ts` | Create | Test payload shared by two test files. |
| `packages/web/src/components/analytics/ControlPlaneAnalytics.tsx` | Create | The Control Plane view. |
| `packages/web/src/components/analytics/ControlPlaneAnalytics.test.tsx` | Create | View tests. |
| `packages/web/src/components/analytics/UsageAnalytics.tsx` | Create (moved) | The current Usage body, unchanged in behavior. |
| `packages/web/src/components/analytics/AnalyticsView.tsx` | Rewrite | The shell: title, view switch, filters, provider list. |
| `packages/web/src/components/analytics/AnalyticsView.test.tsx` | Modify | Clear the stored view; switch tests. |
| `packages/web/src/components/mobile/MobileApp.tsx` | Modify | Bottom tab label "Usage" → "Analytics". |
| `packages/web/vite.config.ts` | Modify | `DISPATCH_API_TARGET` for the dev proxy (verification only). |

---

### Task 1: Core — payload types, scope, rule B, and the summary

**Files:**
- Create: `packages/core/src/analytics/control-plane-types.ts`
- Create: `packages/core/src/analytics/control-plane.ts`
- Test: `packages/core/src/analytics/control-plane.test.ts`

**Interfaces:**
- Consumes: `initSchema` (`../db/schema.js`), `usageDb.insertClosed` (`../db/usage.js`) in tests.
- Produces (used by Tasks 2–4):
  - `interface CpRange { from?: string; to?: string; projectId?: string; provider?: string }`
  - `const MISSION_IDLE_MS: number`, `const REVIEW_GATES: ReadonlySet<string>`, `const TOKENS: string`
  - `interface AgentRow { id; sessionId; cli; agentType: string | null; mission: string | null; status; createdAt; lastAt }`
  - `interface CoordinatorRow { id; sessionId; cli; createdAt; archivedAt: string | null }`
  - `interface Mission { sessionId; name; agents: AgentRow[]; firstAt; lastAt; status: MissionStatus }`
  - `interface Scope { now: Date; agents: AgentRow[]; cliAgents: AgentRow[]; coordinators: CoordinatorRow[]; missions: Mission[] }`
  - `inRange(iso: string, r: CpRange): boolean`
  - `missionState(agents: Pick<AgentRow, 'status' | 'lastAt'>[], now: Date): MissionStatus`
  - `buildMissions(agents: AgentRow[], now: Date, provider?: string): Mission[]`
  - `loadScope(db, r: CpRange, now: Date): Scope`
  - `existedInRange(c: CoordinatorRow, r: CpRange): boolean`
  - `usageWhere(r: CpRange): { sql: string; params: unknown[] }` (needs `usage_turns u LEFT JOIN terminals t ON t.id = u.terminal_id`)
  - `cpSummary(db, r: CpRange, s: Scope): ControlPlaneSummary`
  - All payload types in `control-plane-types.ts`.

- [ ] **Step 1: Create the payload types**

Create `packages/core/src/analytics/control-plane-types.ts`:

```ts
/**
 * The Control Plane analytics payload: GET /api/analytics/control-plane.
 *
 * Types only, with no imports, so the web client imports this file directly
 * (packages/web/src/api/types.ts re-exports it) and the two sides cannot drift.
 */

export type AgentSeriesKey = 'implementer' | 'researcher' | 'planner' | 'review';
export type MissionStatus = 'active' | 'completed';

export interface ControlPlaneSummary {
  /** Coordinator threads that existed at any time in the range (archived ones included). */
  sessions: number;
  /** Coordinator threads with at least one turn in the range. */
  sessionsActive: number;
  /** Coordinator threads created in the range. */
  sessionsNew: number;
  /** Local days with at least one coordinator turn in the range. */
  activeDays: number;
  missionsStarted: number;
  missionsCompleted: number;
  agentsStarted: number;
  controlPlaneTokens: number;
  agentTokens: number;
}

export interface ControlPlaneProjectRow {
  projectId: string;
  name: string;
  sessions: number;
  activeDays: number;
  missionsStarted: number;
  missionsCompleted: number;
  agents: number;
  controlPlaneTokens: number;
  agentTokens: number;
}

export interface ControlPlaneTypeRow {
  agentType: string;
  agents: number;
  avgTurnSeconds: number | null;
  tokens: number;
  /** Agents per CLI, for example { codex: 19, 'claude-code': 11 }. */
  cli: Record<string, number>;
}

export interface ControlPlaneMissionRow {
  projectId: string;
  projectName: string;
  mission: string;
  agents: number;
  reviewGates: number;
  firstAt: string;
  lastAt: string;
  lengthDays: number;
  status: MissionStatus;
}

export interface ControlPlaneAnalytics {
  summary: ControlPlaneSummary;
  /** Every local day (YYYY-MM-DD) in the range, oldest first: the continuous chart axis. */
  days: string[];
  /** Every local Monday (YYYY-MM-DD) in the range, oldest first. */
  weeks: string[];
  agentsByDay: { day: string; key: AgentSeriesKey; value: number; reviewGates?: number }[];
  tokensByDay: { day: string; key: 'control-plane' | 'agents'; value: number }[];
  messagesByDay: { day: string; key: 'you' | 'control-plane'; value: number }[];
  missionsCompletedByWeek: { week: string; value: number }[];
  /** now − 7 days. A week that ends after this instant is still settling under the idle rule. */
  settlingSince: string;
  byProject: ControlPlaneProjectRow[];
  byType: ControlPlaneTypeRow[];
  missions: ControlPlaneMissionRow[];
}
```

- [ ] **Step 2: Write the failing tests**

Create `packages/core/src/analytics/control-plane.test.ts`:

```ts
// Day buckets are local time, so the assertions below only hold in a known zone.
process.env.TZ = 'UTC';

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as usageDb from '../db/usage.js';
import { cpSummary, loadScope, missionState, MISSION_IDLE_MS, type CpRange } from './control-plane.js';

const NOW = new Date('2026-09-29T12:00:00.000Z'); // a Tuesday
const DAY = 24 * 60 * 60 * 1000;
/** The ISO instant `n` days before NOW. */
const ago = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

let d: Database.Database;

function project(id: string, name = id) {
  const t = ago(100);
  d.prepare(`INSERT INTO sessions (id, provider, name, working_dir, created_at, updated_at, last_activity_at)
             VALUES (?, 'claude-code', ?, '/tmp', ?, ?, ?)`).run(id, name, t, t, t);
}

interface ThreadInput {
  id: string; project: string; config: Record<string, unknown>; created: string;
  cli?: string; status?: string; lastActivity?: string; archived?: string;
}
function thread(o: ThreadInput) {
  d.prepare(`INSERT INTO terminals (id, session_id, type, label, status, created_at, config, last_activity_at, archived_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(o.id, o.project, o.cli ?? 'claude-code', o.id, o.status ?? 'waiting', o.created,
      JSON.stringify(o.config), o.lastActivity ?? null, o.archived ?? null);
}

type Extra = Partial<Omit<ThreadInput, 'id' | 'project' | 'config' | 'created'>>;

function coordinator(id: string, projectId: string, created: string, extra: Extra = {}) {
  thread({ id, project: projectId, created, config: { transport: 'structured', role: 'coordinator' }, ...extra });
}

function agent(id: string, projectId: string, agentType: string, created: string,
  extra: Extra & { mission?: string; roleRun?: string } = {}) {
  const { mission, roleRun, ...rest } = extra;
  thread({
    id, project: projectId, created, ...rest,
    config: { transport: 'structured', role: 'agent', agentType, ...(mission ? { mission } : {}), ...(roleRun ? { roleRun } : {}) },
  });
}

function turn(id: string, terminalId: string, projectId: string, role: 'coordinator' | 'agent',
  startedAt: string, tokens: number, o: { provider?: string; seconds?: number } = {}) {
  usageDb.insertClosed(d, {
    id, terminalId, projectId, provider: o.provider ?? 'claude-code', model: 'claude-opus-5', role,
    startedAt, endedAt: new Date(Date.parse(startedAt) + (o.seconds ?? 10) * 1000).toISOString(), outcome: 'idle',
    input: tokens, output: 0, cacheRead: 0, cacheCreate: 0, messages: 1, toolCalls: 0, backfilled: false,
  });
}

const summarize = (r: CpRange) => cpSummary(d, r, loadScope(d, r, NOW));

beforeEach(() => {
  d = new Database(':memory:');
  initSchema(d);
  project('p1', 'Project One');
  project('p2', 'Project Two');
});

describe('sessions', () => {
  it('counts coordinators that existed in the range, archived ones included', () => {
    coordinator('c-live', 'p1', ago(60));
    coordinator('c-old', 'p1', ago(90), { archived: ago(40) }); // archived before the range
    coordinator('c-new', 'p2', ago(5), { archived: ago(2) });   // created and archived in the range
    const s = summarize({ from: ago(30) });
    expect(s.sessions).toBe(2);
    expect(s.sessionsNew).toBe(1);
    expect(summarize({}).sessions).toBe(3);
  });

  it('counts active sessions and active days from coordinator turns', () => {
    coordinator('c1', 'p1', ago(60));
    coordinator('c2', 'p2', ago(60));
    turn('t1', 'c1', 'p1', 'coordinator', ago(3), 100);
    turn('t2', 'c1', 'p1', 'coordinator', ago(3), 100);
    turn('t3', 'c1', 'p1', 'coordinator', ago(1), 100);
    const s = summarize({ from: ago(30) });
    expect(s.sessionsActive).toBe(1);
    expect(s.activeDays).toBe(2);
  });

  it('applies the provider filter to coordinators', () => {
    coordinator('c1', 'p1', ago(60));
    coordinator('c2', 'p2', ago(60), { cli: 'codex' });
    expect(summarize({ provider: 'codex' }).sessions).toBe(1);
  });
});

describe('agents', () => {
  it('counts agents started in the range and never counts a role run', () => {
    agent('a1', 'p1', 'implementer', ago(2));
    agent('a2', 'p1', 'researcher', ago(40));
    agent('r1', 'p1', 'researcher', ago(1), { roleRun: 'nightly-check' });
    expect(summarize({ from: ago(30) }).agentsStarted).toBe(1);
  });

  it('applies the project and provider filters', () => {
    agent('a1', 'p1', 'implementer', ago(2));
    agent('a2', 'p2', 'code-reviewer', ago(2), { cli: 'codex' });
    expect(summarize({ projectId: 'p2' }).agentsStarted).toBe(1);
    expect(summarize({ provider: 'codex' }).agentsStarted).toBe(1);
  });
});

describe('missions (rule B)', () => {
  it('completes a mission with no live agent after 7 idle days', () => {
    expect(missionState([{ status: 'waiting', lastAt: ago(8) }], NOW)).toBe('completed');
    expect(missionState([{ status: 'waiting', lastAt: ago(6) }], NOW)).toBe('active');
  });

  it('keeps a mission active while an agent is working or queued', () => {
    expect(missionState([{ status: 'waiting', lastAt: ago(20) }, { status: 'working', lastAt: ago(20) }], NOW)).toBe('active');
    expect(missionState([{ status: 'queued', lastAt: ago(20) }], NOW)).toBe('active');
  });

  it('treats exactly 7 idle days as still active', () => {
    const edge = new Date(NOW.getTime() - MISSION_IDLE_MS).toISOString();
    expect(missionState([{ status: 'waiting', lastAt: edge }], NOW)).toBe('active');
  });

  it('takes last activity from last_activity_at and archived_at, not only created_at', () => {
    agent('a1', 'p1', 'implementer', ago(20), { mission: 'M', lastActivity: ago(3) });
    agent('a2', 'p1', 'reviewer', ago(20), { mission: 'N', archived: ago(2) });
    expect(loadScope(d, {}, NOW).missions.map((m) => m.status)).toEqual(['active', 'active']);
  });

  it('opens an old mission again when a new agent joins it', () => {
    agent('a1', 'p1', 'implementer', ago(30), { mission: 'M' });
    expect(loadScope(d, {}, NOW).missions[0].status).toBe('completed');
    agent('a2', 'p1', 'implementer', ago(1), { mission: 'M' });
    expect(loadScope(d, {}, NOW).missions[0].status).toBe('active');
  });

  it('counts started in range and completed in range as separate events', () => {
    agent('a1', 'p1', 'implementer', ago(40), { mission: 'Old', lastActivity: ago(20) });
    agent('a2', 'p1', 'implementer', ago(5), { mission: 'New' });
    const s = summarize({ from: ago(30) });
    expect(s.missionsStarted).toBe(1);   // "New"
    expect(s.missionsCompleted).toBe(1); // "Old": started before the range, completed in it
  });

  it('keys a mission by project and name, and ignores agents with no mission', () => {
    agent('a1', 'p1', 'implementer', ago(5), { mission: 'Same' });
    agent('a2', 'p2', 'implementer', ago(5), { mission: 'Same' });
    agent('a3', 'p1', 'implementer', ago(5));
    expect(loadScope(d, {}, NOW).missions).toHaveLength(2);
  });

  it('keeps a mission under a provider filter when one of its agents runs on that CLI', () => {
    agent('a1', 'p1', 'implementer', ago(5), { mission: 'Mixed' });
    agent('a2', 'p1', 'code-reviewer', ago(5), { mission: 'Mixed', cli: 'codex' });
    agent('a3', 'p1', 'implementer', ago(5), { mission: 'Claude only' });
    const missions = loadScope(d, { provider: 'codex' }, NOW).missions;
    expect(missions.map((m) => m.name)).toEqual(['Mixed']);
    expect(missions[0].agents).toHaveLength(2);
  });
});

describe('tokens', () => {
  it('splits Control Plane and agent tokens and drops role-run turns', () => {
    coordinator('c1', 'p1', ago(60));
    agent('a1', 'p1', 'implementer', ago(5));
    agent('r1', 'p1', 'researcher', ago(5), { roleRun: 'nightly' });
    turn('t1', 'c1', 'p1', 'coordinator', ago(2), 300);
    turn('t2', 'a1', 'p1', 'agent', ago(2), 900);
    turn('t3', 'r1', 'p1', 'agent', ago(2), 5000);
    const s = summarize({ from: ago(30) });
    expect(s.controlPlaneTokens).toBe(300);
    expect(s.agentTokens).toBe(900);
    // The provider filter reaches the token sums too.
    expect(summarize({ from: ago(30), provider: 'codex' }).agentTokens).toBe(0);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run src/analytics/control-plane.test.ts`
Expected: FAIL with `Failed to load url ./control-plane.js` (the module does not exist yet).

- [ ] **Step 4: Write the implementation**

Create `packages/core/src/analytics/control-plane.ts`:

```ts
import type Database from 'better-sqlite3';
import type { ControlPlaneSummary, MissionStatus } from './control-plane-types.js';

/**
 * Control Plane analytics — docs/superpowers/specs/2026-09-29-control-plane-analytics-design.md.
 *
 * Every definition lives here and nowhere else: what a session, an agent, and a mission are, and
 * when a mission is complete (missionState). Coordinators and agents are few (about 1,300 rows),
 * so they load once per request from one `terminals` scan and the mission logic runs in
 * TypeScript. Token, day, and message sums stay in SQL.
 */

export interface CpRange { from?: string; to?: string; projectId?: string; provider?: string }

/** Rule B: a mission with no live agent is complete after this long with no activity. */
export const MISSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const REVIEW_GATES: ReadonlySet<string> = new Set(['design-reviewer', 'code-reviewer']);
const LIVE_STATUSES: ReadonlySet<string> = new Set(['working', 'queued']);

export interface AgentRow {
  id: string;
  sessionId: string;
  /** The thread's CLI (terminals.type): claude-code, codex, grok, opencode. */
  cli: string;
  agentType: string | null;
  mission: string | null;
  status: string;
  createdAt: string;
  /** The latest of created_at, last_activity_at, and archived_at. */
  lastAt: string;
}

export interface CoordinatorRow { id: string; sessionId: string; cli: string; createdAt: string; archivedAt: string | null }

export interface Mission {
  sessionId: string;
  name: string;
  agents: AgentRow[];
  firstAt: string;
  lastAt: string;
  status: MissionStatus;
}

/** One request's data, loaded once. `cliAgents` is `agents` after the provider filter. */
export interface Scope { now: Date; agents: AgentRow[]; cliAgents: AgentRow[]; coordinators: CoordinatorRow[]; missions: Mission[] }

/** True when an ISO instant is inside the half-open range [from, to). */
export function inRange(iso: string, r: CpRange): boolean {
  return (!r.from || iso >= r.from) && (!r.to || iso < r.to);
}

function latest(...isos: (string | null | undefined)[]): string {
  let out = '';
  for (const x of isos) if (x && x > out) out = x;
  return out;
}

function parseConfig(raw: string | null): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw ?? '{}');
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Rule B, the idle rule (spec section 4). The one place that decides whether a mission is
 * finished: an explicit finished status, when one exists, replaces the body of this function.
 */
export function missionState(agents: Pick<AgentRow, 'status' | 'lastAt'>[], now: Date): MissionStatus {
  if (agents.some((a) => LIVE_STATUSES.has(a.status))) return 'active';
  const last = latest(...agents.map((a) => a.lastAt));
  return last && now.getTime() - Date.parse(last) > MISSION_IDLE_MS ? 'completed' : 'active';
}

/**
 * Group agents into missions by (project, mission name). Agents with no mission are in no mission.
 * With a provider, a mission stays when at least one of its agents runs on that CLI; its state
 * still uses all of its agents.
 */
export function buildMissions(agents: AgentRow[], now: Date, provider?: string): Mission[] {
  const groups = new Map<string, AgentRow[]>();
  for (const a of agents) {
    if (!a.mission) continue;
    const key = `${a.sessionId}\u0000${a.mission}`;
    const list = groups.get(key);
    if (list) list.push(a);
    else groups.set(key, [a]);
  }
  const out: Mission[] = [];
  for (const list of groups.values()) {
    if (provider && !list.some((a) => a.cli === provider)) continue;
    out.push({
      sessionId: list[0].sessionId,
      name: list[0].mission as string,
      agents: list,
      firstAt: list.reduce((min, a) => (a.createdAt < min ? a.createdAt : min), list[0].createdAt),
      lastAt: latest(...list.map((a) => a.lastAt)),
      status: missionState(list, now),
    });
  }
  return out;
}

/**
 * Load the coordinators and agents in scope. The project filter applies here. The provider filter
 * applies to coordinators and to `cliAgents`, but not to `agents`: a mission's state needs every
 * one of its agents. Scheduled role runs (config.roleRun) are not Control Plane agents.
 */
export function loadScope(db: Database.Database, r: CpRange, now: Date): Scope {
  const rows = db.prepare(`
    SELECT id, session_id, type, status, created_at, last_activity_at, archived_at, config
    FROM terminals ${r.projectId ? 'WHERE session_id = ?' : ''}
  `).all(...(r.projectId ? [r.projectId] : [])) as {
    id: string; session_id: string; type: string; status: string; created_at: string;
    last_activity_at: string | null; archived_at: string | null; config: string | null;
  }[];

  const agents: AgentRow[] = [];
  const coordinators: CoordinatorRow[] = [];
  for (const row of rows) {
    const cfg = parseConfig(row.config);
    if (cfg.role === 'coordinator') {
      if (!r.provider || row.type === r.provider) {
        coordinators.push({ id: row.id, sessionId: row.session_id, cli: row.type, createdAt: row.created_at, archivedAt: row.archived_at });
      }
    } else if (cfg.role === 'agent' && !cfg.roleRun) {
      agents.push({
        id: row.id,
        sessionId: row.session_id,
        cli: row.type,
        agentType: typeof cfg.agentType === 'string' ? cfg.agentType : null,
        mission: typeof cfg.mission === 'string' && cfg.mission.trim() ? cfg.mission.trim() : null,
        status: row.status,
        createdAt: row.created_at,
        lastAt: latest(row.created_at, row.last_activity_at, row.archived_at),
      });
    }
  }
  const cliAgents = r.provider ? agents.filter((a) => a.cli === r.provider) : agents;
  return { now, agents, cliAgents, coordinators, missions: buildMissions(agents, now, r.provider) };
}

/** A coordinator existed in the range when it was created before the end and not archived before the start. */
export function existedInRange(c: CoordinatorRow, r: CpRange): boolean {
  return (!r.to || c.createdAt < r.to) && (!c.archivedAt || !r.from || c.archivedAt >= r.from);
}

/** SQL (alias `u`): one turn's token total, the same sum as the Usage view. */
export const TOKENS = 'u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_create_tokens';

/**
 * WHERE clause for Control Plane usage: closed coordinator and agent turns in the range, with the
 * project and provider filters. The query must `LEFT JOIN terminals t ON t.id = u.terminal_id`,
 * so the clause can drop the turns of scheduled role runs.
 */
export function usageWhere(r: CpRange): { sql: string; params: unknown[] } {
  const parts = [
    'u.ended_at IS NOT NULL',
    "u.role IN ('coordinator', 'agent')",
    "(t.id IS NULL OR (CASE WHEN json_valid(t.config) THEN json_extract(t.config, '$.roleRun') END) IS NULL)",
  ];
  const params: unknown[] = [];
  if (r.from) { parts.push('u.started_at >= ?'); params.push(r.from); }
  if (r.to) { parts.push('u.started_at < ?'); params.push(r.to); }
  if (r.projectId) { parts.push('u.project_id = ?'); params.push(r.projectId); }
  if (r.provider) { parts.push('u.provider = ?'); params.push(r.provider); }
  return { sql: parts.join(' AND '), params };
}

export function cpSummary(db: Database.Database, r: CpRange, s: Scope): ControlPlaneSummary {
  const w = usageWhere(r);
  const usage = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN u.role = 'coordinator' THEN ${TOKENS} END), 0) AS cp,
      COALESCE(SUM(CASE WHEN u.role = 'agent' THEN ${TOKENS} END), 0) AS agents,
      COUNT(DISTINCT CASE WHEN u.role = 'coordinator' THEN u.terminal_id END) AS active_sessions,
      COUNT(DISTINCT CASE WHEN u.role = 'coordinator' THEN date(u.started_at, 'localtime') END) AS active_days
    FROM usage_turns u LEFT JOIN terminals t ON t.id = u.terminal_id
    WHERE ${w.sql}
  `).get(...w.params) as { cp: number; agents: number; active_sessions: number; active_days: number };

  return {
    sessions: s.coordinators.filter((c) => existedInRange(c, r)).length,
    sessionsActive: usage.active_sessions,
    sessionsNew: s.coordinators.filter((c) => inRange(c.createdAt, r)).length,
    activeDays: usage.active_days,
    missionsStarted: s.missions.filter((m) => inRange(m.firstAt, r)).length,
    missionsCompleted: s.missions.filter((m) => m.status === 'completed' && inRange(m.lastAt, r)).length,
    agentsStarted: s.cliAgents.filter((a) => inRange(a.createdAt, r)).length,
    controlPlaneTokens: usage.cp,
    agentTokens: usage.agents,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/core && npx vitest run src/analytics/control-plane.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 6: Type-check**

Run: `cd packages/core && npx tsc --noEmit -p .`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/analytics/control-plane-types.ts packages/core/src/analytics/control-plane.ts packages/core/src/analytics/control-plane.test.ts
git commit -m "feat(analytics): Control Plane scope, idle rule, and summary

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Core — chart series and the continuous axes

**Files:**
- Modify: `packages/core/src/analytics/control-plane.ts` (append)
- Test: `packages/core/src/analytics/control-plane.test.ts` (append)

**Interfaces:**
- Consumes (Task 1): `CpRange`, `Scope`, `loadScope`, `inRange`, `usageWhere`, `TOKENS`, `MISSION_IDLE_MS`, `REVIEW_GATES`.
- Produces (used by Task 3):
  - `localDay(iso: string): string`, `localMonday(day: string): string`, `daysBetween(first: string, last: string): number`
  - `agentSeriesKey(agentType: string | null): AgentSeriesKey | null`
  - `cpSeries(db, r: CpRange, s: Scope): Pick<ControlPlaneAnalytics, 'days' | 'weeks' | 'agentsByDay' | 'tokensByDay' | 'messagesByDay' | 'missionsCompletedByWeek' | 'settlingSince'>`

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/analytics/control-plane.test.ts`, change the import from `./control-plane.js` to:

```ts
import { cpSeries, cpSummary, loadScope, missionState, MISSION_IDLE_MS, type CpRange } from './control-plane.js';
```

Add these helpers under `const summarize = …`:

```ts
const series = (r: CpRange) => cpSeries(d, r, loadScope(d, r, NOW));

let uuid = 0;
function message(terminalId: string, source: string, createdAt: string) {
  d.prepare('INSERT INTO message_source (terminal_id, uuid, source, created_at) VALUES (?, ?, ?, ?)')
    .run(terminalId, `u${uuid++}`, source, createdAt);
}
```

Append at the end of the file:

```ts
describe('series', () => {
  it('buckets agents by local day and folds the reviewer types into review, counting gates', () => {
    agent('a1', 'p1', 'implementer', '2026-09-27T10:00:00.000Z');
    agent('a2', 'p1', 'code-reviewer', '2026-09-27T11:00:00.000Z', { cli: 'codex' });
    agent('a3', 'p1', 'reviewer', '2026-09-27T12:00:00.000Z');
    agent('a4', 'p1', 'design-reviewer', '2026-09-28T09:00:00.000Z');
    expect(series({ from: ago(30) }).agentsByDay).toEqual([
      { day: '2026-09-27', key: 'implementer', value: 1 },
      { day: '2026-09-27', key: 'review', value: 2, reviewGates: 1 },
      { day: '2026-09-28', key: 'review', value: 1, reviewGates: 1 },
    ]);
  });

  it('sums tokens per day for the Control Plane and for agents', () => {
    coordinator('c1', 'p1', ago(60));
    agent('a1', 'p1', 'implementer', ago(5));
    turn('t1', 'c1', 'p1', 'coordinator', '2026-09-27T10:00:00.000Z', 100);
    turn('t2', 'c1', 'p1', 'coordinator', '2026-09-27T11:00:00.000Z', 50);
    turn('t3', 'a1', 'p1', 'agent', '2026-09-27T12:00:00.000Z', 400);
    expect(series({ from: ago(30) }).tokensByDay).toEqual([
      { day: '2026-09-27', key: 'agents', value: 400 },
      { day: '2026-09-27', key: 'control-plane', value: 150 },
    ]);
  });

  it('counts your messages to a coordinator and coordinator messages to agents, nothing else', () => {
    coordinator('c1', 'p1', ago(60));
    agent('a1', 'p1', 'implementer', ago(5));
    thread({ id: 'plain', project: 'p1', created: ago(5), config: { transport: 'structured' } });
    message('c1', 'user', '2026-09-27T10:00:00.000Z');
    message('c1', 'user', '2026-09-27T11:00:00.000Z');
    message('a1', 'coordinator', '2026-09-27T12:00:00.000Z');
    message('a1', 'user', '2026-09-27T12:30:00.000Z');        // you → an agent: not counted
    message('plain', 'coordinator', '2026-09-27T13:00:00.000Z'); // a peer message: not counted
    expect(series({ from: ago(30) }).messagesByDay).toEqual([
      { day: '2026-09-27', key: 'control-plane', value: 1 },
      { day: '2026-09-27', key: 'you', value: 2 },
    ]);
  });

  it('counts completed missions per local Monday week, by completion time', () => {
    // 2026-09-14 and 2026-09-21 are Mondays; 2026-09-20 is a Sunday.
    agent('a1', 'p1', 'implementer', '2026-09-10T10:00:00.000Z', { mission: 'A', lastActivity: '2026-09-15T10:00:00.000Z' });
    agent('a2', 'p1', 'implementer', '2026-09-10T10:00:00.000Z', { mission: 'B', lastActivity: '2026-09-20T23:00:00.000Z' });
    agent('a3', 'p1', 'implementer', '2026-09-10T10:00:00.000Z', { mission: 'C', lastActivity: '2026-09-21T01:00:00.000Z' });
    expect(series({ from: ago(30) }).missionsCompletedByWeek).toEqual([
      { week: '2026-09-14', value: 2 },
      { week: '2026-09-21', value: 1 },
    ]);
  });

  it('returns a continuous day axis from the range start to today, and Monday weeks', () => {
    const out = series({ from: '2026-09-26T00:00:00.000Z' });
    expect(out.days).toEqual(['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29']);
    expect(out.weeks).toEqual(['2026-09-21', '2026-09-28']);
  });

  it('starts an all-time axis at the first day with data, and is empty with no data', () => {
    expect(series({}).days).toEqual([]);
    agent('a1', 'p1', 'implementer', '2026-09-27T10:00:00.000Z');
    expect(series({}).days).toEqual(['2026-09-27', '2026-09-28', '2026-09-29']);
  });

  it('ends the axis at the range end when the range ends before today', () => {
    expect(series({ from: '2026-09-01T00:00:00.000Z', to: '2026-09-03T00:00:00.000Z' }).days)
      .toEqual(['2026-09-01', '2026-09-02']);
  });

  it('marks the settling window as the 7 days before now', () => {
    expect(series({}).settlingSince).toBe('2026-09-22T12:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run src/analytics/control-plane.test.ts`
Expected: FAIL — `cpSeries` is not exported (`TypeError: … is not a function`) in the 8 new tests.

- [ ] **Step 3: Write the implementation**

In `packages/core/src/analytics/control-plane.ts`, change the type import to:

```ts
import type { AgentSeriesKey, ControlPlaneAnalytics, ControlPlaneSummary, MissionStatus } from './control-plane-types.js';
```

Append:

```ts
/* ------------------------------------------------------------ local days */

function dayString(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(day: string, n: number): string {
  const d = parseDay(day);
  d.setDate(d.getDate() + n);
  return dayString(d);
}

/** The local day (YYYY-MM-DD) of an instant: the same bucket as SQLite `date(x, 'localtime')`. */
export function localDay(iso: string): string {
  return dayString(new Date(iso));
}

/** The Monday on or before a local day. */
export function localMonday(day: string): string {
  return addDays(day, -((parseDay(day).getDay() + 6) % 7));
}

/** Whole local days from one day to another. Rounded, so a DST change cannot make it fractional. */
export function daysBetween(first: string, last: string): number {
  return Math.round((parseDay(last).getTime() - parseDay(first).getTime()) / (24 * 60 * 60 * 1000));
}

/** Every `step`-th day from `first` to `last`, inclusive. Capped, so a bad range cannot run long. */
function daySpan(first: string, last: string, step = 1): string[] {
  const out: string[] = [];
  for (let d = first; d <= last && out.length < 5000; d = addDays(d, step)) out.push(d);
  return out;
}

/* ---------------------------------------------------------------- series */

/** Spec section 4: four agent-type series; `review` holds the ordinary reviewer and both gates. */
export function agentSeriesKey(agentType: string | null): AgentSeriesKey | null {
  switch (agentType) {
    case 'implementer':
    case 'researcher':
    case 'planner':
      return agentType;
    case 'reviewer':
    case 'design-reviewer':
    case 'code-reviewer':
      return 'review';
    default:
      return null;
  }
}

/**
 * WHERE clause for messages (aliases `ms`, and `t` for the thread that RECEIVES the message).
 * "You → Control Plane" is a user message on a coordinator. "Control Plane → agents" is a
 * coordinator-sourced message on an agent: the spawn task and message_agent. message_thread also
 * tags peer messages 'coordinator', so the agent check is what scopes this series.
 */
function messageWhere(r: CpRange): { sql: string; params: unknown[] } {
  const role = "(CASE WHEN json_valid(t.config) THEN json_extract(t.config, '$.role') END)";
  const roleRun = "(CASE WHEN json_valid(t.config) THEN json_extract(t.config, '$.roleRun') END)";
  const parts = [
    `((ms.source = 'user' AND ${role} = 'coordinator') OR (ms.source = 'coordinator' AND ${role} = 'agent' AND ${roleRun} IS NULL))`,
  ];
  const params: unknown[] = [];
  if (r.from) { parts.push('ms.created_at >= ?'); params.push(r.from); }
  if (r.to) { parts.push('ms.created_at < ?'); params.push(r.to); }
  if (r.projectId) { parts.push('t.session_id = ?'); params.push(r.projectId); }
  if (r.provider) { parts.push('t.type = ?'); params.push(r.provider); }
  return { sql: parts.join(' AND '), params };
}

type SeriesPart = Pick<ControlPlaneAnalytics,
  'days' | 'weeks' | 'agentsByDay' | 'tokensByDay' | 'messagesByDay' | 'missionsCompletedByWeek' | 'settlingSince'>;

export function cpSeries(db: Database.Database, r: CpRange, s: Scope): SeriesPart {
  const byDayKey = (a: { day: string; key: string }, b: { day: string; key: string }) =>
    a.day.localeCompare(b.day) || a.key.localeCompare(b.key);

  const agentPoints = new Map<string, ControlPlaneAnalytics['agentsByDay'][number]>();
  for (const a of s.cliAgents) {
    if (!inRange(a.createdAt, r)) continue;
    const key = agentSeriesKey(a.agentType);
    if (!key) continue;
    const day = localDay(a.createdAt);
    const id = `${day}|${key}`;
    const point = agentPoints.get(id) ?? { day, key, value: 0 };
    point.value += 1;
    if (key === 'review') point.reviewGates = (point.reviewGates ?? 0) + (REVIEW_GATES.has(a.agentType as string) ? 1 : 0);
    agentPoints.set(id, point);
  }
  const agentsByDay = [...agentPoints.values()].sort(byDayKey);

  const w = usageWhere(r);
  const tokensByDay = db.prepare(`
    SELECT date(u.started_at, 'localtime') AS day,
           CASE WHEN u.role = 'coordinator' THEN 'control-plane' ELSE 'agents' END AS key,
           COALESCE(SUM(${TOKENS}), 0) AS value
    FROM usage_turns u LEFT JOIN terminals t ON t.id = u.terminal_id
    WHERE ${w.sql}
    GROUP BY day, key ORDER BY day, key
  `).all(...w.params) as ControlPlaneAnalytics['tokensByDay'];

  const m = messageWhere(r);
  const messagesByDay = db.prepare(`
    SELECT date(ms.created_at, 'localtime') AS day,
           CASE WHEN ms.source = 'user' THEN 'you' ELSE 'control-plane' END AS key,
           COUNT(*) AS value
    FROM message_source ms JOIN terminals t ON t.id = ms.terminal_id
    WHERE ${m.sql}
    GROUP BY day, key ORDER BY day, key
  `).all(...m.params) as ControlPlaneAnalytics['messagesByDay'];

  const weekCounts = new Map<string, number>();
  for (const mission of s.missions) {
    if (mission.status !== 'completed' || !inRange(mission.lastAt, r)) continue;
    const week = localMonday(localDay(mission.lastAt));
    weekCounts.set(week, (weekCounts.get(week) ?? 0) + 1);
  }
  const missionsCompletedByWeek = [...weekCounts]
    .map(([week, value]) => ({ week, value }))
    .sort((a, b) => a.week.localeCompare(b.week));

  // The continuous axis runs from the range start (for "All time": the first day with data) to
  // today or the range end, whichever is earlier. `to` is exclusive.
  const endMs = Math.min(s.now.getTime(), r.to ? Date.parse(r.to) - 1 : Infinity);
  const lastDay = localDay(new Date(endMs).toISOString());
  const dataDays = [...agentsByDay, ...tokensByDay, ...messagesByDay].map((p) => p.day)
    .concat(missionsCompletedByWeek.map((p) => p.week));
  const firstDay = r.from
    ? localDay(r.from)
    : dataDays.reduce<string | null>((min, x) => (min === null || x < min ? x : min), null);
  const days = firstDay && firstDay <= lastDay ? daySpan(firstDay, lastDay) : [];
  const weeks = days.length ? daySpan(localMonday(days[0]), localMonday(lastDay), 7) : [];

  return {
    days,
    weeks,
    agentsByDay,
    tokensByDay,
    messagesByDay,
    missionsCompletedByWeek,
    settlingSince: new Date(s.now.getTime() - MISSION_IDLE_MS).toISOString(),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/core && npx vitest run src/analytics/control-plane.test.ts`
Expected: PASS, 22 tests.

- [ ] **Step 5: Type-check**

Run: `cd packages/core && npx tsc --noEmit -p .`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/analytics/control-plane.ts packages/core/src/analytics/control-plane.test.ts
git commit -m "feat(analytics): Control Plane day and week series

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Core — the tables and the full payload

**Files:**
- Modify: `packages/core/src/analytics/control-plane.ts` (append)
- Test: `packages/core/src/analytics/control-plane.test.ts` (append)

**Interfaces:**
- Consumes (Tasks 1–2): `Scope`, `loadScope`, `inRange`, `existedInRange`, `usageWhere`, `TOKENS`, `REVIEW_GATES`, `localDay`, `daysBetween`, `cpSummary`, `cpSeries`.
- Produces (used by Task 4): `controlPlaneAnalytics(db, r: CpRange, now?: Date): ControlPlaneAnalytics`, and `cpTables(db, r, s)`.

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/analytics/control-plane.test.ts`, change the import to:

```ts
import {
  controlPlaneAnalytics, cpSeries, cpSummary, loadScope, missionState, MISSION_IDLE_MS, type CpRange,
} from './control-plane.js';
```

Append:

```ts
describe('tables', () => {
  it('builds one row per project, and the sessions column adds up to the tile', () => {
    coordinator('c1', 'p1', ago(60));
    coordinator('c2', 'p2', ago(60));
    agent('a1', 'p1', 'implementer', ago(3), { mission: 'M' });
    turn('t1', 'c1', 'p1', 'coordinator', ago(3), 100);
    turn('t2', 'a1', 'p1', 'agent', ago(3), 300);
    const out = controlPlaneAnalytics(d, { from: ago(30) }, NOW);
    expect(out.byProject.map((p) => p.projectId)).toEqual(['p1', 'p2']);
    expect(out.byProject[0]).toMatchObject({
      name: 'Project One', sessions: 1, activeDays: 1, missionsStarted: 1, agents: 1, controlPlaneTokens: 100, agentTokens: 300,
    });
    expect(out.byProject[1]).toMatchObject({ name: 'Project Two', sessions: 1, agents: 0, activeDays: 0 });
    expect(out.byProject.reduce((n, p) => n + p.sessions, 0)).toBe(out.summary.sessions);
  });

  it('builds one row per agent type with tokens, the mean turn time, and the CLI mix', () => {
    agent('a1', 'p1', 'code-reviewer', ago(3), { cli: 'codex' });
    agent('a2', 'p1', 'code-reviewer', ago(3));
    agent('a3', 'p1', 'implementer', ago(3));
    turn('t1', 'a1', 'p1', 'agent', ago(3), 100, { seconds: 20, provider: 'codex' });
    turn('t2', 'a2', 'p1', 'agent', ago(3), 50, { seconds: 40 });
    expect(controlPlaneAnalytics(d, { from: ago(30) }, NOW).byType).toEqual([
      { agentType: 'code-reviewer', agents: 2, avgTurnSeconds: 30, tokens: 150, cli: { codex: 1, 'claude-code': 1 } },
      { agentType: 'implementer', agents: 1, avgTurnSeconds: null, tokens: 0, cli: { 'claude-code': 1 } },
    ]);
  });

  it('lists the missions active in the range, newest first, with whole-mission values', () => {
    agent('a1', 'p1', 'implementer', ago(60), { mission: 'Long' });
    agent('a2', 'p1', 'code-reviewer', ago(2), { mission: 'Long' });
    agent('a3', 'p1', 'implementer', ago(50), { mission: 'Out of range' });
    agent('a4', 'p2', 'implementer', ago(10), { mission: 'Done', lastActivity: ago(9) });
    const out = controlPlaneAnalytics(d, { from: ago(30) }, NOW);
    expect(out.missions.map((m) => m.mission)).toEqual(['Long', 'Done']);
    expect(out.missions[0]).toMatchObject({ projectName: 'Project One', agents: 2, reviewGates: 1, lengthDays: 59, status: 'active' });
    expect(out.missions[1]).toMatchObject({ projectName: 'Project Two', status: 'completed', lengthDays: 2 });
  });

  it('limits the missions table to 50 rows', () => {
    for (let i = 0; i < 55; i += 1) agent(`a${i}`, 'p1', 'implementer', ago(2), { mission: `M${i}` });
    expect(controlPlaneAnalytics(d, { from: ago(30) }, NOW).missions).toHaveLength(50);
  });

  it('returns every block of the payload', () => {
    expect(Object.keys(controlPlaneAnalytics(d, {}, NOW)).sort()).toEqual([
      'agentsByDay', 'byProject', 'byType', 'days', 'messagesByDay', 'missions',
      'missionsCompletedByWeek', 'settlingSince', 'summary', 'tokensByDay', 'weeks',
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run src/analytics/control-plane.test.ts`
Expected: FAIL — `controlPlaneAnalytics` is not exported, in the 5 new tests.

- [ ] **Step 3: Write the implementation**

In `packages/core/src/analytics/control-plane.ts`, change the type import to:

```ts
import type {
  AgentSeriesKey, ControlPlaneAnalytics, ControlPlaneMissionRow, ControlPlaneProjectRow,
  ControlPlaneSummary, ControlPlaneTypeRow, MissionStatus,
} from './control-plane-types.js';
```

Append:

```ts
/* ---------------------------------------------------------------- tables */

const MISSION_ROWS = 50;

/** SQL (alias `u`): a turn's duration in seconds, or NULL when it has none. The Usage view's rule. */
const DURATION = `CASE WHEN u.ended_at > u.started_at AND (u.telemetry_version = 0 OR u.duration_ms IS NOT NULL)
  THEN CASE WHEN u.telemetry_version = 1 THEN u.duration_ms / 1000.0
            ELSE (julianday(u.ended_at) - julianday(u.started_at)) * 86400.0 END END`;

type TablePart = Pick<ControlPlaneAnalytics, 'byProject' | 'byType' | 'missions'>;

export function cpTables(db: Database.Database, r: CpRange, s: Scope): TablePart {
  const names = new Map(
    (db.prepare('SELECT id, name FROM sessions').all() as { id: string; name: string }[]).map((x) => [x.id, x.name]),
  );
  const nameOf = (id: string) => names.get(id) ?? id;
  const w = usageWhere(r);

  // BY PROJECT: a row for each project with a session in the range or any activity in it.
  const usage = new Map((db.prepare(`
    SELECT u.project_id AS pid,
           COALESCE(SUM(CASE WHEN u.role = 'coordinator' THEN ${TOKENS} END), 0) AS cp,
           COALESCE(SUM(CASE WHEN u.role = 'agent' THEN ${TOKENS} END), 0) AS agents,
           COUNT(DISTINCT CASE WHEN u.role = 'coordinator' THEN date(u.started_at, 'localtime') END) AS days
    FROM usage_turns u LEFT JOIN terminals t ON t.id = u.terminal_id
    WHERE ${w.sql}
    GROUP BY u.project_id
  `).all(...w.params) as { pid: string; cp: number; agents: number; days: number }[]).map((x) => [x.pid, x]));

  const projects = new Map<string, ControlPlaneProjectRow>();
  const project = (pid: string): ControlPlaneProjectRow => {
    let row = projects.get(pid);
    if (!row) {
      const u = usage.get(pid);
      row = {
        projectId: pid, name: nameOf(pid), sessions: 0, activeDays: u?.days ?? 0,
        missionsStarted: 0, missionsCompleted: 0, agents: 0,
        controlPlaneTokens: u?.cp ?? 0, agentTokens: u?.agents ?? 0,
      };
      projects.set(pid, row);
    }
    return row;
  };
  for (const c of s.coordinators) if (existedInRange(c, r)) project(c.sessionId).sessions += 1;
  for (const mission of s.missions) {
    if (inRange(mission.firstAt, r)) project(mission.sessionId).missionsStarted += 1;
    if (mission.status === 'completed' && inRange(mission.lastAt, r)) project(mission.sessionId).missionsCompleted += 1;
  }
  for (const a of s.cliAgents) if (inRange(a.createdAt, r)) project(a.sessionId).agents += 1;
  for (const pid of usage.keys()) project(pid);
  const byProject = [...projects.values()]
    .sort((a, b) => b.agents - a.agents || b.activeDays - a.activeDays || a.name.localeCompare(b.name));

  // BY AGENT TYPE: agents created in the range, and their turns in the range.
  const turnStats = new Map((db.prepare(`
    SELECT u.terminal_id AS id, COALESCE(SUM(${TOKENS}), 0) AS tokens,
           SUM(${DURATION}) AS seconds, COUNT(${DURATION}) AS timed
    FROM usage_turns u LEFT JOIN terminals t ON t.id = u.terminal_id
    WHERE ${w.sql} AND u.role = 'agent'
    GROUP BY u.terminal_id
  `).all(...w.params) as { id: string; tokens: number; seconds: number | null; timed: number }[]).map((x) => [x.id, x]));

  const types = new Map<string, ControlPlaneTypeRow & { seconds: number; timed: number }>();
  for (const a of s.cliAgents) {
    if (!inRange(a.createdAt, r)) continue;
    const key = a.agentType ?? 'unknown';
    let row = types.get(key);
    if (!row) {
      row = { agentType: key, agents: 0, avgTurnSeconds: null, tokens: 0, cli: {}, seconds: 0, timed: 0 };
      types.set(key, row);
    }
    row.agents += 1;
    row.cli[a.cli] = (row.cli[a.cli] ?? 0) + 1;
    const stats = turnStats.get(a.id);
    if (stats) {
      row.tokens += stats.tokens;
      row.seconds += stats.seconds ?? 0;
      row.timed += stats.timed;
    }
  }
  const byType: ControlPlaneTypeRow[] = [...types.values()]
    .map(({ seconds, timed, ...row }) => ({ ...row, avgTurnSeconds: timed > 0 ? Math.round(seconds / timed) : null }))
    .sort((a, b) => b.agents - a.agents || a.agentType.localeCompare(b.agentType));

  // MISSIONS · ACTIVE IN RANGE: the values describe the whole mission, not only the range.
  const missions: ControlPlaneMissionRow[] = s.missions
    .filter((mission) => mission.agents.some((a) => inRange(a.createdAt, r) || inRange(a.lastAt, r)))
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt) || a.name.localeCompare(b.name))
    .slice(0, MISSION_ROWS)
    .map((mission) => ({
      projectId: mission.sessionId,
      projectName: nameOf(mission.sessionId),
      mission: mission.name,
      agents: mission.agents.length,
      reviewGates: mission.agents.filter((a) => REVIEW_GATES.has(a.agentType ?? '')).length,
      firstAt: mission.firstAt,
      lastAt: mission.lastAt,
      lengthDays: daysBetween(localDay(mission.firstAt), localDay(mission.lastAt)) + 1,
      status: mission.status,
    }));

  return { byProject, byType, missions };
}

/** The whole payload for GET /api/analytics/control-plane. `now` is a parameter for tests. */
export function controlPlaneAnalytics(db: Database.Database, r: CpRange, now: Date = new Date()): ControlPlaneAnalytics {
  const s = loadScope(db, r, now);
  return { summary: cpSummary(db, r, s), ...cpSeries(db, r, s), ...cpTables(db, r, s) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/core && npx vitest run src/analytics/control-plane.test.ts`
Expected: PASS, 27 tests.

- [ ] **Step 5: Type-check**

Run: `cd packages/core && npx tsc --noEmit -p .`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/analytics/control-plane.ts packages/core/src/analytics/control-plane.test.ts
git commit -m "feat(analytics): Control Plane tables and payload

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Core — the route

**Files:**
- Modify: `packages/core/src/routes/analytics.ts`
- Test: `packages/core/src/routes/analytics.test.ts`

**Interfaces:**
- Consumes (Task 3): `controlPlaneAnalytics(db, r)`.
- Produces: `GET /api/analytics/control-plane?from&to&projectId&provider` → `ControlPlaneAnalytics` JSON. The web client (Task 6) calls it.

- [ ] **Step 1: Write the failing test**

In `packages/core/src/routes/analytics.test.ts`, add inside `describe('analytics routes', …)`:

```ts
  it('GET /control-plane returns the Control Plane payload and applies the filters', async () => {
    const t = '2026-08-10T10:00:00.000Z';
    d.prepare(`INSERT INTO sessions (id, provider, name, working_dir, created_at, updated_at, last_activity_at)
               VALUES ('proj1', 'claude-code', 'One', '/tmp', ?, ?, ?), ('proj2', 'claude-code', 'Two', '/tmp', ?, ?, ?)`)
      .run(t, t, t, t, t, t);
    d.prepare(`INSERT INTO terminals (id, session_id, type, label, status, created_at, config)
               VALUES ('c1', 'proj1', 'claude-code', 'Overseer', 'waiting', ?, ?), ('c2', 'proj2', 'codex', 'Overseer', 'waiting', ?, ?)`)
      .run(t, JSON.stringify({ role: 'coordinator' }), t, JSON.stringify({ role: 'coordinator' }));

    const all = await request(app(d)).get('/api/analytics/control-plane');
    expect(all.status).toBe(200);
    expect(Object.keys(all.body).sort()).toEqual([
      'agentsByDay', 'byProject', 'byType', 'days', 'messagesByDay', 'missions',
      'missionsCompletedByWeek', 'settlingSince', 'summary', 'tokensByDay', 'weeks',
    ]);
    expect(all.body.summary.sessions).toBe(2);

    const get = async (q: string) => (await request(app(d)).get(`/api/analytics/control-plane?${q}`)).body.summary.sessions;
    expect(await get('projectId=proj2')).toBe(1);
    expect(await get('provider=codex')).toBe(1);
    expect(await get('to=2026-08-01T00:00:00.000Z')).toBe(0);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/core && npx vitest run src/routes/analytics.test.ts -t "control-plane"`
Expected: FAIL — `expected 404 to be 200`.

- [ ] **Step 3: Add the route**

In `packages/core/src/routes/analytics.ts`, add the import under the `queries.js` import:

```ts
import { controlPlaneAnalytics } from '../analytics/control-plane.js';
```

Add the route after the `/records` route:

```ts
  // The Control Plane view (spec 2026-09-29-control-plane-analytics-design.md): one payload per
  // refresh. The same filters as the Usage routes; every value is a bound parameter.
  router.get('/control-plane', (req, res) => {
    res.json(controlPlaneAnalytics(db, range(req.query)));
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/core && npx vitest run src/routes/analytics.test.ts src/analytics`
Expected: PASS, all tests in both files.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/routes/analytics.ts packages/core/src/routes/analytics.test.ts
git commit -m "feat(analytics): GET /api/analytics/control-plane

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Web — move the shared parts out of AnalyticsView

This is a move with two small additions to `Kpi` (`caption`, `info`) and one to `chartTooltip` (the item argument). The Usage view must render the same DOM as before.

**Files:**
- Create: `packages/web/src/components/analytics/parts.tsx`
- Modify: `packages/web/src/components/analytics/AnalyticsView.tsx`
- Test: `packages/web/src/components/analytics/parts.test.tsx`

**Interfaces:**
- Produces (used by Tasks 6–7), all exported from `./parts`:
  - styles: `panel`, `labelStyle`, `inputStyle`, `muted` (`React.CSSProperties`)
  - `fmtTokens(n: number | null | undefined): string`, `fmtSeconds(s: number): string`, `fmtDay(iso: string): string`, `localDayString(d: Date): string`, `startOfLocalDay(daysAgo: number): Date`, `normKey(k: string): string`
  - `type ChartTheme = { text: string; muted: string; grid: string; surface: string }`
  - `Kpi({ label, value, title?, badge?, badgeTitle?, caption?, info? })`
  - `Block({ title, note?, children, style? })`, `NoData({ height, message? })`
  - `chartTooltip(theme: ChartTheme, formatter?: (v: unknown, name: unknown, item?: { payload?: Record<string, unknown> }) => [string, string])`

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/components/analytics/parts.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Kpi } from './parts';

describe('Kpi', () => {
  it('renders only the label and the value when no caption or info is given', () => {
    render(<Kpi label="TURNS" value="12" />);
    expect(screen.getByText('TURNS').parentElement!.textContent).toBe('TURNS12');
  });

  it('renders a caption under the value, and an info mark that carries its text', () => {
    render(<Kpi label="MISSIONS COMPLETED" value="11" caption="since Aug 15" info="No working or queued agent, and no activity for 7 days." />);
    expect(screen.getByText('since Aug 15')).toBeTruthy();
    expect(screen.getByLabelText('No working or queued agent, and no activity for 7 days.').getAttribute('title'))
      .toBe('No working or queued agent, and no activity for 7 days.');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/web && npx vitest run src/components/analytics/parts.test.tsx`
Expected: FAIL — `Failed to resolve import "./parts"`.

- [ ] **Step 3: Create `parts.tsx`**

Create `packages/web/src/components/analytics/parts.tsx`:

```tsx
import { Tooltip } from 'recharts';

/*
 * The parts both Analytics views share: styles, number and day formatters, the KPI tile, the
 * block panel, the empty state, and the one tooltip style. Moved out of AnalyticsView.tsx so the
 * Usage and Control Plane views cannot drift apart.
 */

/* ------------------------------------------------------------------ styles */

export const panel: React.CSSProperties = {
  background: 'var(--color-elevated)', border: '1px solid var(--color-border)',
  borderRadius: 12, padding: 14, minWidth: 0,
};
export const labelStyle: React.CSSProperties = {
  font: '500 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)',
};
export const inputStyle: React.CSSProperties = {
  height: 28, padding: '0 8px', background: 'var(--color-elevated)',
  border: '1px solid var(--color-border)', borderRadius: 7,
  color: 'var(--color-text-primary)', fontSize: 12,
};
export const muted: React.CSSProperties = { color: 'var(--color-text-tertiary)', fontSize: 12.5 };

/* ------------------------------------------------------------- formatting */

const COMPACT = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return '—';
  return n < 1000 ? String(n) : COMPACT.format(n);
}

export function fmtSeconds(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtDay(iso: string): string {
  // 'YYYY-MM-DD' from the query layer, already bucketed in local time.
  return iso.length >= 10 ? iso.slice(5) : iso;
}

export function localDayString(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function startOfLocalDay(daysAgo: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d;
}

/** Empty model/outcome keys are real rows with an unknown key, not missing rows. */
export function normKey(k: string): string { return k === '' ? 'unknown' : k; }

/* ------------------------------------------------------------- small parts */

export type ChartTheme = { text: string; muted: string; grid: string; surface: string };

/**
 * A KPI tile. `caption` adds a line under the value; `info` adds a mark in the label row whose
 * title and accessible name carry the text. With neither, the DOM is exactly the old tile.
 */
export function Kpi({ label, value, title, badge, badgeTitle, caption, info }: {
  label: string; value: string; title?: string; badge?: string; badgeTitle?: string; caption?: string; info?: string;
}) {
  return (
    <div style={panel} title={title}>
      <div style={labelStyle}>
        {label}
        {info && <span aria-label={info} title={info} style={{ float: 'right', cursor: 'help', letterSpacing: 0 }}>ⓘ</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 6 }}>
        <span style={{ fontSize: 21, fontWeight: 600, color: 'var(--color-text-primary)' }}>{value}</span>
        {badge && (
          <span
            title={badgeTitle}
            style={{
              font: '500 9.5px var(--font-mono)', letterSpacing: '.6px', color: 'var(--color-text-tertiary)',
              border: '1px solid var(--color-border)', borderRadius: 5, padding: '1px 5px', cursor: 'help',
            }}
          >{badge}</span>
        )}
      </div>
      {caption && <div style={{ ...muted, fontSize: 11.5, marginTop: 4 }}>{caption}</div>}
    </div>
  );
}

export function Block({ title, note, children, style }: {
  title: string; note?: string; children: React.ReactNode; style?: React.CSSProperties;
}) {
  return (
    <div style={{ ...panel, ...style }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <div style={labelStyle}>{title}</div>
        {note && <div style={{ font: '400 10px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{note}</div>}
      </div>
      <div style={{ marginTop: 12 }}>{children}</div>
    </div>
  );
}

export function NoData({ height, message = 'No turns in this range.' }: { height: number; message?: string }) {
  return <div style={{ ...muted, height, display: 'flex', alignItems: 'center' }}>{message}</div>;
}

/**
 * One tooltip, styled once. Every chart gets a tooltip; only the value formatter differs. The
 * formatter's third argument is the hovered item, whose `payload` is the chart row.
 */
export function chartTooltip(
  theme: ChartTheme,
  formatter?: (v: unknown, name: unknown, item?: { payload?: Record<string, unknown> }) => [string, string],
) {
  return (
    <Tooltip
      cursor={{ fill: 'rgba(255,255,255,0.04)' }}
      contentStyle={{ background: theme.surface, border: `1px solid ${theme.grid}`, borderRadius: 8, fontSize: 12 }}
      labelStyle={{ color: theme.muted }}
      itemStyle={{ color: theme.text }}
      formatter={formatter as never}
    />
  );
}
```

- [ ] **Step 4: Make AnalyticsView use `parts.tsx`**

In `packages/web/src/components/analytics/AnalyticsView.tsx`:

1. Delete the `/* styles */` block (`panel`, `labelStyle`, `inputStyle`, `ghost`, `muted`). `ghost` has no user; do not move it.
2. Delete the `/* formatting */` block (`COMPACT`, `fmtTokens`, `fmtSeconds`, `fmtDay`, `localDayString`, `startOfLocalDay`, `normKey`).
3. Delete `Kpi`, `Block`, `NoData`, and `chartTooltip` from the `/* small parts */` block.
4. Replace the recharts import with (the `Tooltip` import moves to `parts.tsx`):

```tsx
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  ResponsiveContainer, XAxis, YAxis,
} from 'recharts';
```

5. Add under the `chartTheme` import:

```tsx
import {
  Block, Kpi, NoData, chartTooltip, fmtDay, fmtSeconds, fmtTokens, inputStyle, labelStyle,
  localDayString, muted, normKey, panel, startOfLocalDay, type ChartTheme,
} from './parts';
```

6. In `RankedBars`, change the `theme` prop type from `{ text: string; muted: string; grid: string; surface: string }` to `ChartTheme`.
7. If `useCallback` is imported but no longer used, remove it from the `react` import.

- [ ] **Step 5: Run the tests**

Run: `cd packages/web && npx vitest run src/components/analytics`
Expected: PASS — `parts.test.tsx` (2 tests) and every existing Analytics test, unchanged.

- [ ] **Step 6: Type-check**

Run: `cd packages/web && npx tsc --noEmit -p .`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/components/analytics/parts.tsx packages/web/src/components/analytics/parts.test.tsx packages/web/src/components/analytics/AnalyticsView.tsx
git commit -m "refactor(web): move the shared Analytics parts to parts.tsx

Kpi gains an optional caption and info mark; with neither, its DOM is unchanged.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Web — the Control Plane view

**Files:**
- Modify: `packages/web/src/api/types.ts`
- Modify: `packages/web/src/api/client.ts`
- Create: `packages/web/src/components/analytics/controlPlaneFixture.ts`
- Create: `packages/web/src/components/analytics/ControlPlaneAnalytics.tsx`
- Test: `packages/web/src/components/analytics/ControlPlaneAnalytics.test.tsx`

**Interfaces:**
- Consumes: `GET /api/analytics/control-plane` (Task 4); `parts.tsx` exports (Task 5); `SERIES`, `OTHER`, `resolveChartTheme` from `./chartTheme`; `useAnalyticsFeed` from `../../stores/analytics`; `useIsMobile` from `../../hooks/useIsMobile`.
- Produces (used by Task 7):
  - `api.analyticsControlPlane(r: AnalyticsRange): Promise<ControlPlaneAnalytics>`
  - `ControlPlaneAnalytics({ from?: string; projectId: string; provider: string })` React component (named export from `./ControlPlaneAnalytics`)
  - `CP_FIXTURE: ControlPlaneAnalytics` from `./controlPlaneFixture` (tests only)

- [ ] **Step 1: Add the types and the client method**

In `packages/web/src/api/types.ts`, add after the `AnalyticsTracking` interface:

```ts
// Control Plane analytics. The payload type lives in core, in a file with no imports, so the
// daemon and the client share one definition.
export type {
  AgentSeriesKey, ControlPlaneAnalytics, ControlPlaneMissionRow, ControlPlaneProjectRow,
  ControlPlaneSummary, ControlPlaneTypeRow, MissionStatus,
} from '../../../core/src/analytics/control-plane-types';
```

In `packages/web/src/api/client.ts`, add `ControlPlaneAnalytics` to the long `import type { … } from './types';` list, and add this method after `analyticsTracking`:

```ts
  analyticsControlPlane: (r: AnalyticsRange) => req<ControlPlaneAnalytics>(`/api/analytics/control-plane${qs(r)}`),
```

- [ ] **Step 2: Create the test fixture**

Create `packages/web/src/components/analytics/controlPlaneFixture.ts`:

```ts
import type { ControlPlaneAnalytics } from '../../api/types';

/** A small payload in the real shape, shared by the Control Plane view tests. */
export const CP_FIXTURE: ControlPlaneAnalytics = {
  summary: {
    sessions: 15, sessionsActive: 5, sessionsNew: 1, activeDays: 20, missionsStarted: 15,
    missionsCompleted: 11, agentsStarted: 437, controlPlaneTokens: 1_649_010_423, agentTokens: 4_422_830_988,
  },
  days: ['2026-09-27', '2026-09-28', '2026-09-29'],
  weeks: ['2026-09-21', '2026-09-28'],
  agentsByDay: [
    { day: '2026-09-27', key: 'implementer', value: 12 },
    { day: '2026-09-28', key: 'review', value: 3, reviewGates: 2 },
  ],
  tokensByDay: [
    { day: '2026-09-27', key: 'agents', value: 400_000_000 },
    { day: '2026-09-27', key: 'control-plane', value: 150_000_000 },
  ],
  messagesByDay: [
    { day: '2026-09-27', key: 'control-plane', value: 25 },
    { day: '2026-09-27', key: 'you', value: 30 },
  ],
  missionsCompletedByWeek: [{ week: '2026-09-21', value: 3 }],
  settlingSince: '2026-09-22T12:00:00.000Z',
  byProject: [
    { projectId: 'p1', name: 'PW Legacy', sessions: 1, activeDays: 14, missionsStarted: 3, missionsCompleted: 3, agents: 146, controlPlaneTokens: 190, agentTokens: 810 },
    { projectId: 'p2', name: 'Sandbox', sessions: 1, activeDays: 0, missionsStarted: 0, missionsCompleted: 0, agents: 0, controlPlaneTokens: 0, agentTokens: 0 },
    { projectId: 'p3', name: 'Dispatch', sessions: 2, activeDays: 0, missionsStarted: 0, missionsCompleted: 0, agents: 0, controlPlaneTokens: 0, agentTokens: 0 },
  ],
  byType: [
    { agentType: 'code-reviewer', agents: 30, avgTurnSeconds: 255, tokens: 81_000_000, cli: { codex: 19, 'claude-code': 11 } },
  ],
  missions: [
    { projectId: 'p1', projectName: 'PW Legacy', mission: 'Sage consumers', agents: 46, reviewGates: 13, firstAt: '2026-09-16T10:00:00.000Z', lastAt: '2026-09-29T10:00:00.000Z', lengthDays: 14, status: 'active' },
    { projectId: 'p1', projectName: 'PW Legacy', mission: 'PLM UAT Round 1', agents: 49, reviewGates: 2, firstAt: '2026-09-01T10:00:00.000Z', lastAt: '2026-09-09T10:00:00.000Z', lengthDays: 9, status: 'completed' },
  ],
};
```

- [ ] **Step 3: Write the failing tests**

Create `packages/web/src/components/analytics/ControlPlaneAnalytics.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { ControlPlaneAnalytics } from './ControlPlaneAnalytics';
import { api } from '../../api/client';
import { useAnalyticsFeed } from '../../stores/analytics';
import { CP_FIXTURE } from './controlPlaneFixture';

/** After the tracking start below, so the token caption carries no "since" note. */
const FROM = '2026-09-01T00:00:00.000Z';

function stub(payload = CP_FIXTURE) {
  const spy = vi.spyOn(api, 'analyticsControlPlane').mockResolvedValue(payload);
  vi.spyOn(api, 'analyticsTracking').mockResolvedValue({ trackingStartedAt: '2026-08-15T00:00:00.000Z' });
  return spy;
}

describe('ControlPlaneAnalytics', () => {
  beforeEach(() => { vi.restoreAllMocks(); useAnalyticsFeed.setState({ rev: 0 }); });

  it('renders the six KPI tiles with their captions', async () => {
    stub();
    render(<ControlPlaneAnalytics from={FROM} projectId="" provider="" />);
    // 'SESSIONS' is also a table header, so wait on the tile's own caption.
    await waitFor(() => expect(screen.getByText('5 active · 1 new in range')).toBeTruthy());
    expect(screen.getByText('days with a Control Plane turn')).toBeTruthy();
    expect(screen.getByText('437')).toBeTruthy();
    expect(screen.getByText('27%')).toBeTruthy();
    expect(screen.getByText('1.6B of 6.1B Control Plane and agent tokens')).toBeTruthy();
    expect(screen.getByLabelText('No working or queued agent, and no activity for 7 days.')).toBeTruthy();
  });

  it('adds the tracking date to the token caption when the range starts before tracking', async () => {
    stub();
    render(<ControlPlaneAnalytics projectId="" provider="" />);
    await waitFor(() => expect(screen.getByText(/Control Plane and agent tokens · since /)).toBeTruthy());
  });

  it('sends the filters to the daemon', async () => {
    const spy = stub();
    render(<ControlPlaneAnalytics from={FROM} projectId="p1" provider="codex" />);
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ from: FROM, projectId: 'p1', provider: 'codex' }));
  });

  it('folds projects with no activity into one footer row whose sessions add up', async () => {
    stub();
    render(<ControlPlaneAnalytics from={FROM} projectId="" provider="" />);
    await waitFor(() => expect(screen.getAllByText('PW Legacy').length).toBeGreaterThan(0));
    expect(screen.queryByText('Sandbox')).toBeNull();
    expect(screen.getByText('2 more projects · 3 sessions · no activity in range')).toBeTruthy();
  });

  it('shows the mission status as text, not only color', async () => {
    stub();
    render(<ControlPlaneAnalytics from={FROM} projectId="" provider="" />);
    await waitFor(() => expect(screen.getByText('Sage consumers')).toBeTruthy());
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('Completed')).toBeTruthy();
    expect(screen.getByText('14 days')).toBeTruthy();
  });

  it('shows the CLI mix and the mean turn time per agent type', async () => {
    stub();
    render(<ControlPlaneAnalytics from={FROM} projectId="" provider="" />);
    await waitFor(() => expect(screen.getByText('codex 19 · claude-code 11')).toBeTruthy());
    expect(screen.getByText('4m 15s')).toBeTruthy();
  });

  it('shows the message totals in the block note, not an average', async () => {
    stub();
    render(<ControlPlaneAnalytics from={FROM} projectId="" provider="" />);
    await waitFor(() => expect(screen.getByText('30 from you · 25 to agents')).toBeTruthy());
  });

  it('fetches again when the daemon reports new data', async () => {
    const spy = stub();
    render(<ControlPlaneAnalytics from={FROM} projectId="" provider="" />);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    act(() => { useAnalyticsFeed.setState({ rev: 1 }); });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });

  it('says there is no activity instead of drawing empty charts', async () => {
    stub({ ...CP_FIXTURE, agentsByDay: [], tokensByDay: [], messagesByDay: [] });
    render(<ControlPlaneAnalytics from={FROM} projectId="" provider="" />);
    await waitFor(() => expect(screen.getAllByText('No Control Plane activity in this range.')).toHaveLength(3));
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd packages/web && npx vitest run src/components/analytics/ControlPlaneAnalytics.test.tsx`
Expected: FAIL — `Failed to resolve import "./ControlPlaneAnalytics"`.

- [ ] **Step 5: Write the view**

Create `packages/web/src/components/analytics/ControlPlaneAnalytics.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceArea, ResponsiveContainer, XAxis, YAxis,
} from 'recharts';
import { api } from '../../api/client';
import { useAnalyticsFeed } from '../../stores/analytics';
import { useIsMobile } from '../../hooks/useIsMobile';
import { OTHER, SERIES, resolveChartTheme } from './chartTheme';
import { Block, Kpi, NoData, chartTooltip, fmtDay, fmtSeconds, fmtTokens, labelStyle, muted } from './parts';
import type {
  AgentSeriesKey, ControlPlaneAnalytics as Payload, ControlPlaneProjectRow, MissionStatus,
} from '../../api/types';

/*
 * The Control Plane view of the Analytics screen
 * (docs/superpowers/specs/2026-09-29-control-plane-analytics-design.md, sections 3 and 6).
 * The shell (AnalyticsView) owns the filters; this view only fetches and draws.
 */

/** Spec 6.4: the agent-type series, in this order and these colors. */
const AGENT_SERIES: { key: AgentSeriesKey; color: string }[] = [
  { key: 'implementer', color: SERIES[0] },
  { key: 'researcher', color: SERIES[1] },
  { key: 'planner', color: SERIES[3] },
  { key: 'review', color: SERIES[2] },
];
/** Pink always means the Control Plane in this view. The other series in a pair is neutral. */
const CONTROL_PLANE = SERIES[4];
const NO_ACTIVITY = 'No Control Plane activity in this range.';
const COMPLETED_INFO = 'No working or queued agent, and no activity for 7 days.';

type Row = Record<string, string | number>;

/** Pivot the long series onto the continuous axes the daemon returns. */
function buildRows(data: Payload): { agents: Row[]; tokens: Row[]; messages: Row[]; weekly: Row[] } {
  const index = new Map(data.days.map((day, i) => [day, i]));
  const agents: Row[] = data.days.map((day) => ({ day }));
  for (const p of data.agentsByDay) {
    const i = index.get(p.day);
    if (i === undefined) continue;
    agents[i][p.key] = p.value;
    if (p.reviewGates !== undefined) agents[i].reviewGates = p.reviewGates;
  }
  const tokens: Row[] = data.days.map((day) => ({ day }));
  for (const p of data.tokensByDay) {
    const i = index.get(p.day);
    if (i !== undefined) tokens[i][p.key] = p.value;
  }
  // Lines need a point on every day, so a quiet day is a zero, not a gap.
  const messages: Row[] = data.days.map((day) => ({ day, you: 0, 'control-plane': 0 }));
  for (const p of data.messagesByDay) {
    const i = index.get(p.day);
    if (i !== undefined) messages[i][p.key] = p.value;
  }
  const byWeek = new Map(data.missionsCompletedByWeek.map((p) => [p.week, p.value]));
  const weekly: Row[] = data.weeks.map((week) => ({ week, value: byWeek.get(week) ?? 0 }));
  return { agents, tokens, messages, weekly };
}

const total = (points: { key: string; value: number }[], key: string) =>
  points.reduce((n, p) => (p.key === key ? n + p.value : n), 0);

/** The instant a local Monday week ends (the next Monday, local midnight), as ISO. */
function weekEnd(week: string): string {
  const [y, m, d] = week.split('-').map(Number);
  return new Date(y, m - 1, d + 7).toISOString();
}

const share = (cp: number, agents: number) => (cp + agents > 0 ? `${Math.round((100 * cp) / (cp + agents))}%` : '—');

const isActive = (r: ControlPlaneProjectRow) =>
  r.agents + r.activeDays + r.missionsStarted + r.missionsCompleted + r.controlPlaneTokens + r.agentTokens > 0;

export function ControlPlaneAnalytics({ from, projectId, provider }: { from?: string; projectId: string; provider: string }) {
  const isMobile = useIsMobile();
  // Recharts cannot read `var(--color-*)`, so the theme resolves to literals once.
  const theme = useMemo(() => resolveChartTheme(), []);
  // The same live signal as Usage: the daemon bumps it every time a turn closes.
  const rev = useAnalyticsFeed((s) => s.rev);
  const [data, setData] = useState<Payload | null>(null);
  const [trackingStartedAt, setTrackingStartedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [payload, tracking] = await Promise.all([
          api.analyticsControlPlane({
            ...(from ? { from } : {}), ...(projectId ? { projectId } : {}), ...(provider ? { provider } : {}),
          }),
          api.analyticsTracking(),
        ]);
        if (cancelled) return;
        setData(payload);
        setTrackingStartedAt(tracking.trackingStartedAt);
        setError(null);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [from, projectId, provider, rev]);

  const rows = useMemo(() => (data ? buildRows(data) : null), [data]);

  if (error && !data) return <div style={{ padding: '12px 0', color: 'var(--color-status-red)' }}>Analytics unavailable: {error}</div>;
  if (!data || !rows) return <div style={{ ...muted, padding: '12px 0' }}>Loading analytics…</div>;

  const { summary } = data;
  const tokenTotal = summary.controlPlaneTokens + summary.agentTokens;
  // Tokens exist only from the tracking start. Say so when the range reaches before it.
  const since = trackingStartedAt && (!from || from < trackingStartedAt)
    ? ` · since ${new Date(trackingStartedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`
    : '';
  const settling = data.weeks.filter((week) => weekEnd(week) > data.settlingSince);

  const chartH = isMobile ? 200 : 240;
  const axisTick = { fill: theme.muted, fontSize: 11 };
  const legend = (
    <Legend
      formatter={(v: string) => <span style={{ color: theme.muted, fontSize: 11 }}>{v}</span>}
      wrapperStyle={{ paddingTop: 4 }}
    />
  );
  const pair: React.CSSProperties = { display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12, marginTop: 12 };
  const xDays = <XAxis dataKey="day" tickFormatter={fmtDay} tick={axisTick} tickLine={false} axisLine={{ stroke: theme.grid }} />;
  const grid = <CartesianGrid stroke={theme.grid} vertical={false} />;
  const margin = { top: 4, right: 8, left: 0, bottom: 0 };

  return (
    <>
      {error && <div style={{ ...muted, color: 'var(--color-status-red)', marginBottom: 12 }}>{error}</div>}

      {/* 1. KPI row — the same position as the Usage KPI row. */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(6, 1fr)', gap: 12 }}>
        <Kpi label="SESSIONS" value={summary.sessions.toLocaleString()} caption={`${summary.sessionsActive} active · ${summary.sessionsNew} new in range`} />
        <Kpi label="ACTIVE DAYS" value={summary.activeDays.toLocaleString()} caption="days with a Control Plane turn" />
        <Kpi label="MISSIONS STARTED" value={summary.missionsStarted.toLocaleString()} />
        <Kpi label="MISSIONS COMPLETED" value={summary.missionsCompleted.toLocaleString()} info={COMPLETED_INFO} />
        <Kpi label="AGENTS STARTED" value={summary.agentsStarted.toLocaleString()} />
        <Kpi
          label="CONTROL PLANE TOKEN SHARE"
          value={tokenTotal > 0 ? share(summary.controlPlaneTokens, summary.agentTokens) : '—'}
          caption={tokenTotal > 0
            ? `${fmtTokens(summary.controlPlaneTokens)} of ${fmtTokens(tokenTotal)} Control Plane and agent tokens${since}`
            : `no recorded tokens${since}`}
        />
      </div>

      {/* 2. Agents started per day, by type. */}
      <div style={{ marginTop: 16 }}>
        <Block title="AGENTS STARTED PER DAY · BY TYPE" note="review includes design-reviewer and code-reviewer">
          {data.agentsByDay.length === 0 ? <NoData height={chartH} message={NO_ACTIVITY} /> : (
            <ResponsiveContainer width="100%" height={chartH} minHeight={chartH}>
              <BarChart data={rows.agents} margin={margin}>
                {grid}
                {xDays}
                <YAxis allowDecimals={false} tick={axisTick} tickLine={false} axisLine={false} width={36} />
                {chartTooltip(theme, (v, name, item) => [
                  name === 'review' ? `${Number(v)} (${Number(item?.payload?.reviewGates ?? 0)} gates)` : String(v),
                  String(name),
                ])}
                {legend}
                {AGENT_SERIES.map((s) => (
                  <Bar
                    key={s.key} dataKey={s.key} name={s.key} stackId="agents" fill={s.color}
                    stroke={theme.surface} strokeWidth={2} radius={[4, 4, 0, 0]} isAnimationActive={false}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          )}
        </Block>
      </div>

      {/* 3. Tokens and messages. Pink is the Control Plane in both. */}
      <div style={pair}>
        <Block title="TOKENS PER DAY · CONTROL PLANE VS AGENTS">
          {data.tokensByDay.length === 0 ? <NoData height={chartH} message={NO_ACTIVITY} /> : (
            <ResponsiveContainer width="100%" height={chartH} minHeight={chartH}>
              <BarChart data={rows.tokens} margin={margin}>
                {grid}
                {xDays}
                <YAxis tickFormatter={fmtTokens} tick={axisTick} tickLine={false} axisLine={false} width={48} />
                {chartTooltip(theme, (v, name) => [fmtTokens(Number(v)), String(name)])}
                {legend}
                <Bar dataKey="agents" name="Agents" stackId="tokens" fill={OTHER} stroke={theme.surface} strokeWidth={2} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                <Bar dataKey="control-plane" name="Control Plane" stackId="tokens" fill={CONTROL_PLANE} stroke={theme.surface} strokeWidth={2} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Block>
        <Block
          title="MESSAGES PER DAY"
          note={`${total(data.messagesByDay, 'you').toLocaleString()} from you · ${total(data.messagesByDay, 'control-plane').toLocaleString()} to agents`}
        >
          {data.messagesByDay.length === 0 ? <NoData height={chartH} message={NO_ACTIVITY} /> : (
            <ResponsiveContainer width="100%" height={chartH} minHeight={chartH}>
              <LineChart data={rows.messages} margin={margin}>
                {grid}
                {xDays}
                <YAxis allowDecimals={false} tick={axisTick} tickLine={false} axisLine={false} width={36} />
                {chartTooltip(theme)}
                {legend}
                <Line type="monotone" dataKey="you" name="You → Control Plane" stroke={OTHER} strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="control-plane" name="Control Plane → agents" stroke={CONTROL_PLANE} strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </Block>
      </div>

      {/* 4. Missions completed per week, and the project table. */}
      <div style={pair}>
        <Block title="MISSIONS COMPLETED PER WEEK" note="weeks start on Monday">
          {rows.weekly.length === 0 ? <NoData height={chartH} message={NO_ACTIVITY} /> : (
            <ResponsiveContainer width="100%" height={chartH} minHeight={chartH}>
              <BarChart data={rows.weekly} margin={margin}>
                <defs>
                  <pattern id="cp-settling" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <rect width="2" height="6" fill={theme.grid} />
                  </pattern>
                </defs>
                {grid}
                <XAxis dataKey="week" tickFormatter={fmtDay} tick={axisTick} tickLine={false} axisLine={{ stroke: theme.grid }} />
                <YAxis allowDecimals={false} tick={axisTick} tickLine={false} axisLine={false} width={36} />
                {chartTooltip(theme, (v) => [String(v), 'missions completed'])}
                {settling.length > 0 && (
                  <ReferenceArea
                    x1={settling[0]} x2={settling[settling.length - 1]} fill="url(#cp-settling)" fillOpacity={1} stroke="none"
                    label={{ value: 'still settling · 7-day idle rule', position: 'insideTop', fill: theme.muted, fontSize: 10 }}
                  />
                )}
                {/* One series, named by the title. Pink: a mission is the Control Plane's unit of work. */}
                <Bar dataKey="value" name="missions completed" fill={CONTROL_PLANE} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Block>
        <Block title="BY PROJECT">
          <ProjectTable rows={data.byProject} />
        </Block>
      </div>

      {/* 5. By agent type. */}
      <div style={{ marginTop: 12 }}>
        <Block title="BY AGENT TYPE">
          {data.byType.length === 0 ? <NoData height={60} message={NO_ACTIVITY} /> : (
            <Table
              head={['Type', 'Agents', 'Avg turn', 'Tokens', 'CLI mix']}
              align={['left', 'right', 'right', 'right', 'left']}
              rows={data.byType.map((t) => [
                t.agentType,
                t.agents.toLocaleString(),
                t.avgTurnSeconds == null ? '—' : fmtSeconds(t.avgTurnSeconds),
                fmtTokens(t.tokens),
                Object.entries(t.cli).sort((a, b) => b[1] - a[1]).map(([cli, n]) => `${cli} ${n}`).join(' · '),
              ])}
            />
          )}
        </Block>
      </div>

      {/* 6. Missions active in the range. */}
      <div style={{ marginTop: 12 }}>
        <Block title="MISSIONS · ACTIVE IN RANGE" note="values cover the whole mission">
          {data.missions.length === 0 ? <NoData height={60} message={NO_ACTIVITY} /> : (
            <Table
              head={['Mission', 'Project', 'Agents', 'Review gates', 'Length', 'Status']}
              align={['left', 'left', 'right', 'right', 'right', 'left']}
              rows={data.missions.map((m) => [
                m.mission,
                m.projectName,
                m.agents.toLocaleString(),
                m.reviewGates.toLocaleString(),
                `${m.lengthDays} ${m.lengthDays === 1 ? 'day' : 'days'}`,
                <StatusChip key="status" status={m.status} />,
              ])}
            />
          )}
        </Block>
      </div>
    </>
  );
}

/** The active projects, then one muted footer row for the rest, so the sessions still add up. */
function ProjectTable({ rows }: { rows: ControlPlaneProjectRow[] }) {
  if (rows.length === 0) return <NoData height={60} message={NO_ACTIVITY} />;
  const active = rows.filter(isActive);
  const idle = rows.filter((r) => !isActive(r));
  const idleSessions = idle.reduce((n, r) => n + r.sessions, 0);
  return (
    <Table
      head={['Project', 'Sessions', 'Active days', 'Started in range', 'Completed in range', 'Agents', 'CP token share']}
      align={['left', 'right', 'right', 'right', 'right', 'right', 'right']}
      rows={active.map((r) => [
        r.name, r.sessions, r.activeDays, r.missionsStarted, r.missionsCompleted, r.agents.toLocaleString(),
        share(r.controlPlaneTokens, r.agentTokens),
      ])}
      footer={idle.length > 0
        ? `${idle.length} more ${idle.length === 1 ? 'project' : 'projects'} · ${idleSessions} ${idleSessions === 1 ? 'session' : 'sessions'} · no activity in range`
        : undefined}
    />
  );
}

function Table({ head, align, rows, footer }: {
  head: string[]; align: ('left' | 'right')[]; rows: React.ReactNode[][]; footer?: string;
}) {
  const cell: React.CSSProperties = { padding: '7px 10px', borderBottom: '1px solid var(--color-border)', whiteSpace: 'nowrap', fontSize: 12.5 };
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', color: 'var(--color-text-primary)' }}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={h} style={{ ...cell, ...labelStyle, textAlign: align[i], fontWeight: 500 }}>{h.toUpperCase()}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {r.map((c, i) => (
                <td key={i} style={{ ...cell, textAlign: align[i], fontFamily: align[i] === 'right' ? 'var(--font-mono)' : undefined }}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {footer && <div style={{ ...muted, padding: '8px 10px' }}>{footer}</div>}
    </div>
  );
}

/** Status as text and a shape, never color alone. */
function StatusChip({ status }: { status: MissionStatus }) {
  const done = status === 'completed';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid var(--color-border)', borderRadius: 999,
      padding: '1px 8px', fontSize: 11, color: done ? 'var(--color-text-secondary)' : 'var(--color-text-primary)',
    }}>
      <span aria-hidden="true">{done ? '✓' : '○'}</span>
      <span>{done ? 'Completed' : 'Active'}</span>
    </span>
  );
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/web && npx vitest run src/components/analytics`
Expected: PASS — `ControlPlaneAnalytics.test.tsx` (9 tests) and every other Analytics test.

- [ ] **Step 7: Type-check**

Run: `cd packages/web && npx tsc --noEmit -p .`
Expected: no output, exit 0.

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/api/types.ts packages/web/src/api/client.ts packages/web/src/components/analytics/controlPlaneFixture.ts packages/web/src/components/analytics/ControlPlaneAnalytics.tsx packages/web/src/components/analytics/ControlPlaneAnalytics.test.tsx
git commit -m "feat(web): the Control Plane analytics view

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Web — the view switch

`AnalyticsView.tsx` becomes the shell. Its current body moves, with no change in behavior, into `UsageAnalytics.tsx`.

**Files:**
- Create (by move): `packages/web/src/components/analytics/UsageAnalytics.tsx`
- Rewrite: `packages/web/src/components/analytics/AnalyticsView.tsx`
- Modify: `packages/web/src/components/analytics/AnalyticsView.test.tsx`
- Modify: `packages/web/src/components/mobile/MobileApp.tsx`

**Interfaces:**
- Consumes: `ControlPlaneAnalytics` (Task 6); `inputStyle`, `muted`, `normKey`, `startOfLocalDay` (Task 5); `CP_FIXTURE` (Task 6, tests).
- Produces:
  - `UsageAnalytics({ from?: string; projectId: string; provider: string; filtered: boolean })`
  - `AnalyticsView()` (same export as today; `App.tsx` and `MobileApp.tsx` import it unchanged)
  - `type AnalyticsTab = 'usage' | 'control-plane'`, `ANALYTICS_TAB_KEY = 'dispatch:analytics-view'`, `loadAnalyticsTab(): AnalyticsTab`

- [ ] **Step 1: Write the failing tests**

In `packages/web/src/components/analytics/AnalyticsView.test.tsx`:

1. Change the first import block to:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AnalyticsView, loadAnalyticsTab } from './AnalyticsView';
import { api } from '../../api/client';
import { useAnalyticsFeed } from '../../stores/analytics';
import { CP_FIXTURE } from './controlPlaneFixture';
```

2. In the existing `describe('AnalyticsView', …)`, change the `beforeEach` to clear the stored view, so no test inherits another test's choice:

```tsx
  beforeEach(() => {
    vi.restoreAllMocks();
    useAnalyticsFeed.setState({ rev: 0 });
    localStorage.removeItem('dispatch:analytics-view');
  });
```

3. Append at the end of the file:

```tsx
describe('AnalyticsView · the view switch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAnalyticsFeed.setState({ rev: 0 });
    localStorage.removeItem('dispatch:analytics-view');
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('opens Usage on a first visit', async () => {
    stub({ ...EMPTY, turns: 3, totalTokens: 10 });
    render(<AnalyticsView />);
    await waitFor(() => expect(screen.getByText('TOTAL TOKENS')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Usage' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Control Plane' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('switches to Control Plane, keeps every filter, and remembers the choice', async () => {
    stub({ ...EMPTY, turns: 3, totalTokens: 10 }, [{ day: localDay(), key: 'codex', value: 5 }]);
    const cp = vi.spyOn(api, 'analyticsControlPlane').mockResolvedValue(CP_FIXTURE);
    render(<AnalyticsView />);

    const provider = await screen.findByLabelText(/provider/i);
    await waitFor(() => expect(provider.textContent).toMatch(/codex/));
    fireEvent.change(provider, { target: { value: 'codex' } });
    fireEvent.change(screen.getByLabelText('Range'), { target: { value: '7' } });

    fireEvent.click(screen.getByRole('button', { name: 'Control Plane' }));

    await waitFor(() => expect(screen.getByText('AGENTS STARTED')).toBeTruthy());
    expect(cp).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'codex', from: expect.any(String) }));
    expect((screen.getByLabelText(/provider/i) as HTMLSelectElement).value).toBe('codex');
    expect((screen.getByLabelText('Range') as HTMLSelectElement).value).toBe('7');
    expect(localStorage.getItem('dispatch:analytics-view')).toBe('control-plane');
    expect(screen.queryByText('TOTAL TOKENS')).toBeNull();
  });

  it('reopens the view the reader chose last', async () => {
    localStorage.setItem('dispatch:analytics-view', 'control-plane');
    stub();
    vi.spyOn(api, 'analyticsControlPlane').mockResolvedValue(CP_FIXTURE);
    render(<AnalyticsView />);
    await waitFor(() => expect(screen.getByText('AGENTS STARTED')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Control Plane' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('falls back to Usage for an unknown stored view', () => {
    localStorage.setItem('dispatch:analytics-view', 'nonsense');
    expect(loadAnalyticsTab()).toBe('usage');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/web && npx vitest run src/components/analytics/AnalyticsView.test.tsx`
Expected: FAIL — `loadAnalyticsTab` is not exported, and there is no `Usage` / `Control Plane` button.

- [ ] **Step 3: Move the Usage body**

Run: `git mv packages/web/src/components/analytics/AnalyticsView.tsx packages/web/src/components/analytics/UsageAnalytics.tsx`

Then edit `packages/web/src/components/analytics/UsageAnalytics.tsx`. Each edit below names the code to find; everything else stays as it is.

1. Delete the `useProjects` import line.
2. In the `./parts` import, remove `inputStyle` (the shell owns the selects now).
3. Delete `type RangeId = …` and the `RANGES` constant (they move to the shell).
4. In `interface Loaded`, delete the `providerOptions` field and its comment.
5. Replace `export function AnalyticsView() {` and the lines up to (not including) the `const [data, setData]` line with:

```tsx
/**
 * The Usage view of the Analytics screen. Behavior is unchanged from the single-pane screen: the
 * shell (AnalyticsView) now owns the title, the view switch, the filters, and the provider list.
 */
export function UsageAnalytics({ from, projectId, provider, filtered }: {
  from?: string; projectId: string; provider: string; filtered: boolean;
}) {
  const isMobile = useIsMobile();
  // Recharts cannot read `var(--color-*)`, so the theme resolves to literals once.
  const theme = useMemo(() => resolveChartTheme(), []);

```

6. Delete the two lines `const days = RANGES.find(…)` and `const from = days == null ? …`.
7. In the filtered-batch effect, delete `providerOptions` from the destructured names, delete its entry `api.analyticsSeries({ ...scope, metric: 'tokens', groupBy: 'provider' }),`, and delete `providerOptions` from the `setData({ … })` object. Keep `const scope = …`: `range` and `calendarRange` still use it.
8. Delete the whole `const providerDomain = useMemo(…)` statement.
9. Replace the two early returns:

```tsx
  if (error && (!data || !domain || !stats)) {
    return <div style={{ flex: 1, padding: 24, color: 'var(--color-status-red)' }}>Analytics unavailable: {error}</div>;
  }
  if (!data || !domain || !stats) {
    return <div style={{ flex: 1, padding: 24, ...muted }}>Loading analytics…</div>;
  }
```

with:

```tsx
  if (error && (!data || !domain || !stats)) {
    return <div style={{ padding: '12px 0', color: 'var(--color-status-red)' }}>Analytics unavailable: {error}</div>;
  }
  if (!data || !domain || !stats) {
    return <div style={{ ...muted, padding: '12px 0' }}>Loading analytics…</div>;
  }
```

10. Delete the line `const filtered = Boolean(projectId) || Boolean(provider) || rangeId !== '30';` (it is a prop now).
11. In the `return (`, delete the outer scroll `<div style={{ flex: 1, minHeight: 0, overflowY: 'auto', …}}>`, the title row (`<span …>Analytics</span>` and its note), and the whole `{/* 1. Filters */}` block. Replace the outer `<div>` with a fragment `<>`, and its closing `</div>` (the one right before the final `);` of the component) with `</>`. The first child is now `{error && <div …>{error}</div>}`.

- [ ] **Step 4: Write the shell**

Create `packages/web/src/components/analytics/AnalyticsView.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { useAnalyticsFeed } from '../../stores/analytics';
import { useProjects } from '../../stores/projects';
import { useIsMobile } from '../../hooks/useIsMobile';
import { inputStyle, muted, normKey, startOfLocalDay } from './parts';
import { UsageAnalytics } from './UsageAnalytics';
import { ControlPlaneAnalytics } from './ControlPlaneAnalytics';
import type { AnalyticsPoint } from '../../api/types';

type RangeId = '7' | '30' | '90' | 'all';
const RANGES: { id: RangeId; label: string; days: number | null }[] = [
  { id: '7', label: 'Last 7 days', days: 7 },
  { id: '30', label: 'Last 30 days', days: 30 },
  { id: '90', label: 'Last 90 days', days: 90 },
  { id: 'all', label: 'All time', days: null },
];

/** The two views of one screen (spec 2026-09-29-control-plane-analytics-design.md, section 3). */
export type AnalyticsTab = 'usage' | 'control-plane';
export const ANALYTICS_TAB_KEY = 'dispatch:analytics-view';

/** The view the reader chose last. A first visit, or an unknown stored value, opens Usage. */
export function loadAnalyticsTab(): AnalyticsTab {
  try {
    return localStorage.getItem(ANALYTICS_TAB_KEY) === 'control-plane' ? 'control-plane' : 'usage';
  } catch {
    return 'usage';
  }
}

function saveAnalyticsTab(tab: AnalyticsTab): void {
  try { localStorage.setItem(ANALYTICS_TAB_KEY, tab); } catch { /* ignore */ }
}

/**
 * The Analytics screen: the title, the view switch, and the filter row, which both views share.
 * A change of view never moves or resets a filter, because the filters live here, above both views.
 */
export function AnalyticsView() {
  const isMobile = useIsMobile();
  const sessions = useProjects((s) => s.sessions);
  const [tab, setTab] = useState<AnalyticsTab>(loadAnalyticsTab);
  const [rangeId, setRangeId] = useState<RangeId>('30');
  const [projectId, setProjectId] = useState('');
  const [provider, setProvider] = useState('');
  const [providerOptions, setProviderOptions] = useState<AnalyticsPoint[]>([]);
  const rev = useAnalyticsFeed((s) => s.rev);

  const days = RANGES.find((r) => r.id === rangeId)?.days ?? null;
  const from = days == null ? undefined : startOfLocalDay(days - 1).toISOString();

  // The provider list is fetched WITHOUT the provider filter, so the select always offers every
  // provider in the range — a filtered list would strand the reader on one. It follows the live
  // revision and re-runs after a pick, so the list stays current in both views.
  useEffect(() => {
    let cancelled = false;
    api.analyticsSeries({ ...(from ? { from } : {}), ...(projectId ? { projectId } : {}), metric: 'tokens', groupBy: 'provider' })
      .then((points) => { if (!cancelled) setProviderOptions(points); })
      .catch(() => { /* keep the last list; each view reports its own errors */ });
    return () => { cancelled = true; };
  }, [from, projectId, provider, rev]);

  const providerDomain = useMemo(
    () => [...new Set(providerOptions.map((p) => normKey(p.key)))].sort(),
    [providerOptions],
  );

  const choose = (next: AnalyticsTab) => { saveAnalyticsTab(next); setTab(next); };
  const filtered = Boolean(projectId) || Boolean(provider) || rangeId !== '30';

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: isMobile ? 14 : 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 20, fontWeight: 600 }}>Analytics</span>
        {!isMobile && <ViewSwitch value={tab} onChange={choose} />}
        <span style={{ ...muted, font: '400 11px var(--font-mono)' }}>days are local time</span>
      </div>
      {isMobile && (
        <div style={{ marginTop: 12 }}>
          <ViewSwitch value={tab} onChange={choose} fullWidth />
        </div>
      )}

      {/* The filter row: the same controls, in the same place, with the same values in both views. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '14px 0 16px' }}>
        <select aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)} style={inputStyle}>
          <option value="">All projects</option>
          {sessions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select aria-label="Range" value={rangeId} onChange={(e) => setRangeId(e.target.value as RangeId)} style={inputStyle}>
          {RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
        <select aria-label="Provider" value={provider} onChange={(e) => setProvider(e.target.value)} style={inputStyle}>
          <option value="">All providers</option>
          {providerDomain.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      {tab === 'usage'
        ? <UsageAnalytics from={from} projectId={projectId} provider={provider} filtered={filtered} />
        : <ControlPlaneAnalytics from={from} projectId={projectId} provider={provider} />}
    </div>
  );
}

/** A segmented control, not document tabs: one screen with two views (spec section 3). */
function ViewSwitch({ value, onChange, fullWidth }: {
  value: AnalyticsTab; onChange: (tab: AnalyticsTab) => void; fullWidth?: boolean;
}) {
  const options: { id: AnalyticsTab; label: string }[] = [
    { id: 'usage', label: 'Usage' },
    { id: 'control-plane', label: 'Control Plane' },
  ];
  return (
    <div
      role="group"
      aria-label="Analytics view"
      style={{
        display: fullWidth ? 'flex' : 'inline-flex', gap: 2, padding: 2,
        background: 'var(--color-base)', border: '1px solid var(--color-border)', borderRadius: 8,
      }}
    >
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.id)}
            style={{
              flex: fullWidth ? 1 : undefined, height: 26, padding: '0 12px', border: 'none', borderRadius: 6,
              cursor: 'pointer', fontSize: 12, fontWeight: active ? 600 : 400,
              background: active ? 'var(--color-hover)' : 'transparent',
              color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 5: Rename the mobile bottom tab**

In `packages/web/src/components/mobile/MobileApp.tsx`, in the bottom tab list, change `['analytics', 'Usage', ChartBar]` to `['analytics', 'Analytics', ChartBar]`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/web && npx vitest run src/components/analytics src/components/mobile`
Expected: PASS — every Analytics test (the 4 new switch tests, the existing Usage tests, the color test, the mount test) and the mobile tests.

- [ ] **Step 7: Type-check**

Run: `cd packages/web && npx tsc --noEmit -p .`
Expected: no output, exit 0. If `tsc` reports an unused import in `UsageAnalytics.tsx` (for example `useProjects` or `inputStyle`), remove that import.

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/components/analytics/AnalyticsView.tsx packages/web/src/components/analytics/UsageAnalytics.tsx packages/web/src/components/analytics/AnalyticsView.test.tsx packages/web/src/components/mobile/MobileApp.tsx
git commit -m "feat(web): Usage | Control Plane view switch on the Analytics screen

The shell owns the title, the switch, and the shared filters; the Usage body moves
unchanged to UsageAnalytics.tsx. The last view is stored in dispatch:analytics-view.
The mobile bottom tab reads \"Analytics\".

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Verification — suites, real data, and a visual check

No production code changes in this task except one dev-server line. Every process it starts is stopped at the end.

**Files:**
- Modify: `packages/web/vite.config.ts` (the dev proxy target reads an environment variable)
- Scratch (not committed): `/tmp/cpa-verify/`

- [ ] **Step 1: Run both full suites and both type checks**

```bash
cd packages/core && npx tsc --noEmit -p . && npx vitest run 2>&1 | tail -5
cd ../web && npx tsc --noEmit -p . && npx vitest run 2>&1 | tail -5
```

Expected: both type checks print nothing; both suites pass. `tests/routes/structured.test.ts` in core is known to fail at random under load (it also fails on `main`). If it fails, run that file alone three times; it must pass at least once, and no other file may fail.

- [ ] **Step 2: Let the dev proxy target another daemon**

In `packages/web/vite.config.ts`, change the proxy line to:

```ts
      '/api': { target: process.env.DISPATCH_API_TARGET ?? 'http://localhost:3456', changeOrigin: true, ws: true },
```

Commit it:

```bash
git add packages/web/vite.config.ts
git commit -m "chore(web): DISPATCH_API_TARGET sets the dev proxy target

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Start an isolated verify daemon on a neutralized copy of the database**

The fake HOME has no CLI credentials, so the daemon cannot run a real agent. The `UPDATE`s stop the copy from resuming or scheduling anything. (They also turn live agents idle in the copy, so a mission state can differ slightly from the live daemon.)

```bash
mkdir -p /tmp/cpa-verify/home/.dispatch
sqlite3 ~/.dispatch/dispatch.db ".backup /tmp/cpa-verify/home/.dispatch/dispatch.db"
sqlite3 /tmp/cpa-verify/home/.dispatch/dispatch.db "UPDATE terminals SET status='waiting' WHERE status IN ('working','queued'); UPDATE agent_schedules SET enabled=0;"
cd packages/core && npx tsc --outDir .verify/dist && mkdir -p .verify/dist/tools && cp src/tools/default-tools.json .verify/dist/tools/
HOME=/tmp/cpa-verify/home PORT=3999 node .verify/dist/server.js > /tmp/cpa-verify/daemon.log 2>&1 &
```

Wait until `/tmp/cpa-verify/daemon.log` contains `Dispatch server listening on port 3999`.

- [ ] **Step 4: Check the payload against the real data**

```bash
FROM=$(node -e "const d=new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()-29); console.log(d.toISOString())")
curl -s "http://localhost:3999/api/analytics/control-plane?from=$FROM" \
  | jq '{summary, days: (.days | length), weeks, projects: .byProject[:6], types: .byType, missions: .missions[:5]}'
```

Expected, compared with the numbers measured on 2026-09-29 for the last 30 days (they grow with new work): `sessions` 15; `sessionsNew` about 1; `activeDays` about 20; `agentsStarted` about 437 or more; the token share `controlPlaneTokens / (controlPlaneTokens + agentTokens)` about 27%; `days` 30; the projects led by PW Legacy, POLYWOOD Analytics, PW Explorer (OS), and Shopify Product Rollup. Report any number that is far from these, and explain it before you continue.

- [ ] **Step 5: Start the Vite dev server against the verify daemon**

```bash
cd packages/web && DISPATCH_API_TARGET=http://localhost:3999 npx vite --port 5199 --strictPort > /tmp/cpa-verify/vite.log 2>&1 &
```

Wait until `/tmp/cpa-verify/vite.log` contains `Local:`.

- [ ] **Step 6: Take the screenshots**

Create `/tmp/cpa-verify/shot.mjs`:

```js
// node shot.mjs <repoRoot> <outDir> — drives headless Chrome over the DevTools protocol.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [repo, out] = process.argv.slice(2);
const WebSocket = createRequire(path.join(repo, 'packages/core/package.json'))('ws');
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=9333',
  `--user-data-dir=${path.join(out, 'profile')}`, 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let targets;
for (let i = 0; i < 50 && !targets; i += 1) {
  try { targets = await (await fetch('http://127.0.0.1:9333/json')).json(); } catch { await sleep(200); }
}
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.once('open', r));
let id = 0;
const pending = new Map();
ws.on('message', (m) => { const msg = JSON.parse(m); if (pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); } });
const send = (method, params = {}) => new Promise((r) => { id += 1; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const run = (expression) => send('Runtime.evaluate', { expression });

await send('Page.enable');
await send('Page.navigate', { url: 'http://localhost:5199/' });
await sleep(3000);
for (const [name, width, height, mobile] of [['desktop', 1440, 2600, false], ['mobile', 390, 2400, true]]) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  for (const tab of ['usage', 'control-plane']) {
    await run(`localStorage.setItem('dispatch:view', 'analytics'); localStorage.setItem('dispatch:analytics-view', '${tab}'); location.reload();`);
    await sleep(4000);
    // The mobile shell keeps its own bottom-tab state, so open Analytics by its tab button.
    if (mobile) { await run(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Analytics')?.click()`); await sleep(3000); }
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, `${name}-${tab}.png`), Buffer.from(shot.data, 'base64'));
  }
}
ws.close();
chrome.kill();
```

Run: `node /tmp/cpa-verify/shot.mjs "$(git rev-parse --show-toplevel)" /tmp/cpa-verify`
Expected: four files, `/tmp/cpa-verify/{desktop,mobile}-{usage,control-plane}.png`.

- [ ] **Step 7: Look at the screenshots and compare them with the mockup**

Open each PNG (the Read tool shows images). Compare with Variant 1 in `docs/superpowers/specs/2026-09-29-control-plane-analytics-mockups.html`. Check:
- The title, the switch, the filters, and the KPI row sit at the same place in both desktop views.
- On mobile, the switch sits under the title at full width, and the bottom tab reads "Analytics".
- Every chart has a legend or a title that names its one series; pink appears only for the Control Plane.
- No label overlaps another label; no table breaks out of its block except by its own horizontal scroll.

Report what you see. Fix a defect in the task that owns the code, with a test where one is possible, and take the screenshots again.

- [ ] **Step 8: Stop everything**

```bash
lsof -ti :5199 | xargs kill 2>/dev/null; lsof -ti :3999 | xargs kill 2>/dev/null; lsof -ti :9333 | xargs kill 2>/dev/null
```

Expected: `lsof -ti :5199 -ti :3999 -ti :9333` prints nothing. Leave `/tmp/cpa-verify` for the owner to inspect; it holds a copy of the database, so do not copy it anywhere else.
