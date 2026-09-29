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
