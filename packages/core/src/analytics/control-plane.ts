import type Database from 'better-sqlite3';
import type {
  AgentSeriesKey, ControlPlaneAnalytics, ControlPlaneMissionRow, ControlPlaneProjectRow,
  ControlPlaneSummary, ControlPlaneTypeRow, MissionStatus,
} from './control-plane-types.js';

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
