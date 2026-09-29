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
