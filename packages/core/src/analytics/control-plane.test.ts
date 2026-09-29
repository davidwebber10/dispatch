// Day buckets are local time, so the assertions below only hold in a known zone.
process.env.TZ = 'UTC';

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as usageDb from '../db/usage.js';
import {
  controlPlaneAnalytics, cpSeries, cpSummary, loadScope, missionState, MISSION_IDLE_MS, type CpRange,
} from './control-plane.js';

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
const series = (r: CpRange) => cpSeries(d, r, loadScope(d, r, NOW));

let uuid = 0;
function message(terminalId: string, source: string, createdAt: string) {
  d.prepare('INSERT INTO message_source (terminal_id, uuid, source, created_at) VALUES (?, ?, ?, ?)')
    .run(terminalId, `u${uuid++}`, source, createdAt);
}

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
