import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { initSchema } from '../db/schema.js';
import * as agentsDb from '../db/agents.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { rowToSession } from '../types.js';
import { AgentService } from '../agents/service.js';
import { createNoopBroadcaster } from '../ws/events.js';
import { RolesService } from './service.js';
import type { SessionService } from '../sessions/service.js';
import type { StatusService } from '../status/service.js';
import type { ThreadStatus } from '../status/events.js';
import type { CreateSessionInput } from '../types.js';

/** Wait one event-loop tick — finalizeRoleRun defers via setImmediate (see its wireSettled
 *  doc comment: structured settles fire before noteTurnOutcome persists config.lastOutcome). */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function writeRole(root: string, name: string, raw: string): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'role.md'), raw);
}

const roleMd = (opts: { name?: string; project?: string; schedule?: string } = {}): string => `---
name: ${opts.name ?? 'x'}
project: ${opts.project ?? 'shopify-product-rollup'}
agentType: researcher
schedule: ${opts.schedule ?? '{"type":"daily","time":"05:30"}'}
tz: America/Indianapolis
authority: stage
wallClockCapMin: 30
---
Check last night's runs.`;

const globalRoleMd = `---
name: digest
global: true
agentType: researcher
schedule: {"type":"daily","time":"07:00"}
---
Send the digest.`;

describe('RolesService', () => {
  let tmp: string;
  let db: Database.Database;
  let sessionStub: Partial<SessionService>;
  let agentService: AgentService;
  let svc: RolesService;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-svc-'));
    db = new Database(':memory:');
    initSchema(db);

    // agent_schedules.project_id has a real FK against sessions(id), so the fixture
    // project (and anything ensureOperationsProject() creates) must be a real row —
    // not just a JS object — for enable() to succeed.
    sessionsDb.create(db, { id: 'proj-1', provider: 'claude-code', name: 'shopify-product-rollup', workingDir: '/tmp/proj-1' });

    sessionStub = {
      list: (status?: string) => sessionsDb.list(db, status).map(rowToSession),
      create: (input: CreateSessionInput) => {
        const id = uuid();
        sessionsDb.create(db, { id, provider: input.provider, name: input.name || 'New Project', workingDir: input.workingDir });
        return rowToSession(sessionsDb.getById(db, id)!);
      },
    };

    agentService = new AgentService(
      db,
      { createRunnerTerminal: () => ({ id: 'term-1' }), stopTerminal: () => {} },
      createNoopBroadcaster(),
    );

    svc = new RolesService({
      db,
      agentService,
      sessionService: sessionStub as unknown as SessionService,
      rolesRoot: tmp,
    });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('list() shows a discovered role as disabled with no schedule', () => {
    writeRole(tmp, 'x', roleMd());
    const entries = svc.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].def.name).toBe('x');
    expect(entries[0].enabled).toBe(false);
    expect(entries[0].scheduleId).toBeUndefined();
    expect(entries[0].error).toBeUndefined();
  });

  it('list() surfaces parse errors as disabled entries with an error message', () => {
    writeRole(tmp, 'broken', 'no frontmatter here');
    const entries = svc.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].def.name).toBe('broken');
    expect(entries[0].enabled).toBe(false);
    expect(entries[0].error).toMatch(/frontmatter/);
  });

  it('never auto-creates a schedule row just from discovery', () => {
    writeRole(tmp, 'x', roleMd());
    svc.list();
    expect(agentsDb.getScheduleByRoleName(db, 'x')).toBeUndefined();
  });

  it('enable() upserts a schedule row keyed by role_name with prompt "" and provider claude-code', () => {
    writeRole(tmp, 'x', roleMd());
    const entry = svc.enable('x');

    expect(entry.enabled).toBe(true);
    expect(entry.scheduleId).toBeTruthy();
    expect(entry.nextRunAt).toBeTruthy();

    const row = agentsDb.getScheduleByRoleName(db, 'x');
    expect(row).toBeTruthy();
    expect(row!.role_name).toBe('x');
    expect(row!.prompt).toBe('');
    expect(row!.provider).toBe('claude-code');
    expect(row!.schedule_kind).toBe('recurring');
    expect(row!.recurrence_rule).toBe(JSON.stringify({ type: 'daily', time: '05:30' }));
    expect(row!.timezone).toBe('America/Indianapolis');
    expect(row!.project_id).toBe('proj-1');
    expect(row!.enabled).toBe(1);

    const listed = svc.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].enabled).toBe(true);
    expect(listed[0].nextRunAt).toBeTruthy();
    expect(listed[0].scheduleId).toBe(row!.id);
  });

  it('enable() called twice never creates a second row for the same role', () => {
    writeRole(tmp, 'x', roleMd());
    const first = svc.enable('x');
    const second = svc.enable('x');
    expect(second.scheduleId).toBe(first.scheduleId);

    const all = db.prepare("SELECT COUNT(*) as n FROM agent_schedules WHERE role_name = 'x'").get() as { n: number };
    expect(all.n).toBe(1);
  });

  it('disable() flips enabled off but keeps the row', () => {
    writeRole(tmp, 'x', roleMd());
    svc.enable('x');
    const before = agentsDb.getScheduleByRoleName(db, 'x')!;

    const entry = svc.disable('x');
    expect(entry.enabled).toBe(false);
    expect(entry.scheduleId).toBe(before.id);

    const row = agentsDb.getScheduleByRoleName(db, 'x');
    expect(row).toBeTruthy();
    expect(row!.enabled).toBe(0);
    expect(row!.id).toBe(before.id);
  });

  it('enable("missing") throws', () => {
    expect(() => svc.enable('missing')).toThrow();
  });

  it('enable() on an unresolvable project throws a clear message', () => {
    writeRole(tmp, 'x', roleMd({ project: 'no-such-project' }));
    expect(() => svc.enable('x')).toThrow(/no-such-project/);
  });

  it('enable() on an invalid role.md throws the parse error', () => {
    writeRole(tmp, 'broken', 'no frontmatter here');
    expect(() => svc.enable('broken')).toThrow(/frontmatter/);
  });

  it('global role enable() finds-or-creates the Operations project', () => {
    writeRole(tmp, 'digest', globalRoleMd);
    const entry = svc.enable('digest');
    expect(entry.enabled).toBe(true);

    const ops = sessionsDb.list(db).map(rowToSession).find((s) => s.name === 'Operations');
    expect(ops).toBeTruthy();
    expect(ops!.workingDir).toBe(path.join(os.homedir(), '.dispatch', 'operations'));

    const row = agentsDb.getScheduleByRoleName(db, 'digest');
    expect(row!.project_id).toBe(ops!.id);

    // A second global role reuses the same Operations project rather than creating another.
    writeRole(tmp, 'digest2', globalRoleMd.replace('name: digest', 'name: digest2'));
    svc.enable('digest2');
    expect(sessionsDb.list(db).map(rowToSession).filter((s) => s.name === 'Operations')).toHaveLength(1);
  });
});

describe('RolesService — role run lifecycle (Task 6)', () => {
  let tmp: string;
  let db: Database.Database;
  let agentService: AgentService;
  let svc: RolesService;
  let terminalCalls: Array<{
    id: string; sessionId: string; type: string; label?: string; skipPermissions?: boolean;
    workingDir?: string; externalId?: string; config?: Record<string, any>;
  }>;
  let messageCalls: Array<{ terminalId: string; content: unknown; source?: string }>;
  let removeCalls: string[];
  let settledListener: ((info: { terminalId: string; sessionId: string; threadStatus: ThreadStatus }) => void) | undefined;
  /** Toggled per-test to exercise the seed-delivery-failure/orphan-cleanup path. */
  let sendThreadMessageShouldThrow: boolean;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-run-'));
    db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 'proj-1', provider: 'claude-code', name: 'shopify-product-rollup', workingDir: '/tmp/proj-1' });

    terminalCalls = [];
    messageCalls = [];
    removeCalls = [];
    settledListener = undefined;
    sendThreadMessageShouldThrow = false;

    const sessionStub: Partial<SessionService> = {
      list: (status?: string) => sessionsDb.list(db, status).map(rowToSession),
      create: (input: CreateSessionInput) => {
        const id = uuid();
        sessionsDb.create(db, { id, provider: input.provider, name: input.name || 'New Project', workingDir: input.workingDir });
        return rowToSession(sessionsDb.getById(db, id)!);
      },
      createTerminal: (sessionId, type, label, skipPermissions, workingDir, externalId, config) => {
        const id = uuid();
        terminalCalls.push({ id, sessionId, type, label, skipPermissions, workingDir, externalId, config });
        terminalsDb.create(db, { id, sessionId, type, label: label || 'term', skipPermissions, workingDir, externalId, config });
        return terminalsDb.rowToTerminal(terminalsDb.getById(db, id)!);
      },
      sendThreadMessage: (terminalId, content, source) => {
        if (sendThreadMessageShouldThrow) throw new Error('seed delivery failed');
        messageCalls.push({ terminalId, content, source });
        return { transport: 'structured', droppedNonText: false };
      },
      removeTerminal: (terminalId: string) => { removeCalls.push(terminalId); },
    };

    agentService = new AgentService(
      db,
      { createRunnerTerminal: () => { throw new Error('non-role path must not be used for a role schedule'); }, stopTerminal: () => {} },
      createNoopBroadcaster(),
    );

    svc = new RolesService({
      db,
      agentService,
      sessionService: sessionStub as unknown as SessionService,
      rolesRoot: tmp,
    });
    agentService.setRoleRunner(svc);

    const fakeStatusService = {
      addThreadSettledListener: (fn: (info: { terminalId: string; sessionId: string; threadStatus: ThreadStatus }) => void) => {
        settledListener = fn;
      },
    } as unknown as StatusService;
    svc.wireSettled(fakeStatusService);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function enableAndFire(): { runId: string; terminalId: string; scheduleId: string } {
    writeRole(tmp, 'x', roleMd());
    const entry = svc.enable('x');
    const run = agentService.runNow(entry.scheduleId!);
    return { runId: run.id, terminalId: run.terminalId!, scheduleId: entry.scheduleId! };
  }

  /** updateConfig REPLACES the whole config blob (see sessions/service.ts's noteTurnOutcome),
   *  so simulate the daemon's own read-merge-write instead of clobbering transport/roleRun/etc. */
  function setLastOutcome(terminalId: string, lastOutcome: Record<string, unknown>): void {
    const existing = JSON.parse(terminalsDb.getById(db, terminalId)!.config || '{}');
    terminalsDb.updateConfig(db, terminalId, { ...existing, lastOutcome });
  }

  it('runNow on a role schedule spawns a structured terminal with the exact config shape and sends the seed as coordinator', () => {
    const { runId, terminalId } = enableAndFire();

    expect(terminalCalls).toHaveLength(1);
    const call = terminalCalls[0];
    expect(call.sessionId).toBe('proj-1');
    expect(call.type).toBe('claude-code');
    expect(call.skipPermissions).toBe(true);
    expect(call.workingDir).toBe('/tmp/proj-1');
    expect(call.externalId).toBeUndefined();
    expect(call.label).toMatch(/^x · \d{4}-\d{2}-\d{2}$/);
    expect(call.config).toEqual({
      transport: 'structured',
      role: 'agent',
      agentType: 'researcher',
      mission: 'x',
      roleRun: 'x',
      roleAuthority: 'stage',
      spawnDepth: 1,
    });

    expect(messageCalls).toHaveLength(1);
    expect(messageCalls[0].terminalId).toBe(terminalId);
    expect(messageCalls[0].source).toBe('coordinator');
    expect(String(messageCalls[0].content)).toContain('# Role: x');
    expect(String(messageCalls[0].content)).toContain('Check last night\'s runs.');

    const run = agentsDb.getRun(db, runId)!;
    expect(run.status).toBe('working');
    expect(run.terminal_id).toBe(terminalId);
  });

  it('re-parses role.md fresh at fire time and fails the run without spawning on a parse error', () => {
    writeRole(tmp, 'x', roleMd());
    const entry = svc.enable('x');

    // The brief broke after enable() — the live definition at fire time must win.
    writeRole(tmp, 'x', 'no frontmatter here');

    const run = agentService.runNow(entry.scheduleId!);

    expect(terminalCalls).toHaveLength(0);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/frontmatter/);
  });

  it('a sendThreadMessage failure removes the orphaned terminal and fails the run, rather than leaving it live and unattached', () => {
    writeRole(tmp, 'x', roleMd());
    const entry = svc.enable('x');
    sendThreadMessageShouldThrow = true;

    const run = agentService.runNow(entry.scheduleId!);

    // The terminal WAS created (createTerminal ran before the send) — but never got its
    // seed, so it must be cleaned up rather than sit there live and orphaned.
    expect(terminalCalls).toHaveLength(1);
    const spawnedId = terminalCalls[0].id;
    expect(removeCalls).toContain(spawnedId);
    expect(messageCalls).toHaveLength(0);

    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/seed delivery failed/);
    // attachTerminal ran before the send failed, so the run row still points at the (now
    // archived) terminal — same pattern cancelRun leaves after stopping a terminal.
    expect(run.terminalId).toBe(spawnedId);
  });

  it('settled: a full contract block in lastOutcome.summary drives outcome/summary/links/proposedBriefChanges', async () => {
    const { runId, terminalId } = enableAndFire();
    setLastOutcome(terminalId, {
      summary: '```json\n{"outcome":"ok","summary":"rolled up 12 SKUs","links":["https://github.com/x/y/pull/1"],"proposedBriefChanges":"tighten step 3"}\n```',
      needsHelp: false,
      inferred: false,
      at: new Date().toISOString(),
    });

    settledListener!({ terminalId, sessionId: 'proj-1', threadStatus: 'idle' });
    await flush();

    const logPath = path.join(tmp, 'x', 'log.jsonl');
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      outcome: 'ok',
      summary: 'rolled up 12 SKUs',
      links: ['https://github.com/x/y/pull/1'],
      proposedBriefChanges: 'tighten step 3',
      attempt: 1,
      terminalId,
    });
    expect(lines[0].start).toBeTruthy();
    expect(lines[0].end).toBeTruthy();

    const run = agentsDb.getRun(db, runId)!;
    expect(run.status).toBe('succeeded');
    expect(removeCalls).toContain(terminalId);
  });

  it('settled: sees a lastOutcome written AFTER the listener fires — the noteTurnOutcome ordering race the setImmediate deferral survives', async () => {
    const { runId, terminalId } = enableAndFire();

    // Mirrors server.ts's real ordering for a structured thread: markIdle (which fires this
    // settled listener) runs BEFORE SessionService.noteTurnOutcome persists config.lastOutcome
    // for the turn that just ended. Fire the listener first, THEN write lastOutcome —
    // synchronously, no await between them — exactly the race the deferral must survive.
    settledListener!({ terminalId, sessionId: 'proj-1', threadStatus: 'idle' });
    setLastOutcome(terminalId, { summary: 'late-written outcome', needsHelp: false, inferred: false, at: new Date().toISOString() });

    await flush();

    const logPath = path.join(tmp, 'x', 'log.jsonl');
    const [entry] = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(entry.summary).toBe('late-written outcome');
    expect(agentsDb.getRun(db, runId)!.status).toBe('succeeded');
  });

  it('settled: finalizing an already-terminal run is a no-op (double settle appends exactly one log line)', async () => {
    const { runId, terminalId } = enableAndFire();
    setLastOutcome(terminalId, { summary: 'done', needsHelp: false, inferred: false, at: new Date().toISOString() });

    settledListener!({ terminalId, sessionId: 'proj-1', threadStatus: 'idle' });
    settledListener!({ terminalId, sessionId: 'proj-1', threadStatus: 'idle' });
    await flush();

    const logPath = path.join(tmp, 'x', 'log.jsonl');
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(agentsDb.getRun(db, runId)!.status).toBe('succeeded');
    expect(removeCalls.filter((id) => id === terminalId)).toHaveLength(1);
  });

  it('settled: falls back to needsHelp/summary when lastOutcome.summary has no contract block', async () => {
    const { runId, terminalId } = enableAndFire();
    setLastOutcome(terminalId, { summary: 'plain text, no json block', needsHelp: true, inferred: false, at: new Date().toISOString() });

    settledListener!({ terminalId, sessionId: 'proj-1', threadStatus: 'needs_input' });
    await flush();

    const logPath = path.join(tmp, 'x', 'log.jsonl');
    const [entry] = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(entry.outcome).toBe('attention');
    expect(entry.summary).toBe('plain text, no json block');
    expect(entry.links).toEqual([]);

    // 'attention' is not 'failed' — the run itself completed; agent_runs only tracks the
    // binary succeeded/failed, the finer outcome lives in the role's log.jsonl for the digest.
    expect(agentsDb.getRun(db, runId)!.status).toBe('succeeded');
  });

  it('settled: declaredState "blocked" forces outcome failed even when the contract said ok', async () => {
    const { runId, terminalId } = enableAndFire();
    setLastOutcome(terminalId, {
      summary: '```json\n{"outcome":"ok","summary":"looked done but isn\'t"}\n```',
      needsHelp: false,
      inferred: false,
      declaredState: 'blocked',
      at: new Date().toISOString(),
    });

    settledListener!({ terminalId, sessionId: 'proj-1', threadStatus: 'idle' });
    await flush();

    const logPath = path.join(tmp, 'x', 'log.jsonl');
    const [entry] = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(entry.outcome).toBe('failed');
    expect(agentsDb.getRun(db, runId)!.status).toBe('failed');
  });

  it('settled: ignores a terminal that is not a role run (config.roleRun unset)', async () => {
    const id = uuid();
    terminalsDb.create(db, { id, sessionId: 'proj-1', type: 'claude-code', label: 'plain chat', config: { transport: 'structured' } });

    expect(() => settledListener!({ terminalId: id, sessionId: 'proj-1', threadStatus: 'idle' })).not.toThrow();
    await flush();

    expect(fs.existsSync(path.join(tmp, 'x'))).toBe(false);
    expect(removeCalls).not.toContain(id);
  });
});

describe('RolesService — supervision: retry-once, 2-night auto-disable, wall cap (Task 7)', () => {
  let tmp: string;
  let db: Database.Database;
  let agentService: AgentService;
  let svc: RolesService;
  let terminalCalls: Array<{ id: string; sessionId: string; config?: Record<string, any> }>;
  let messageCalls: Array<{ terminalId: string; content: unknown }>;
  let removeCalls: string[];
  let interruptCalls: string[];
  let pushCalls: Array<{ terminalId: string; sessionId: string; title: string; body: string }>;
  let settledListener: ((info: { terminalId: string; sessionId: string; threadStatus: ThreadStatus }) => void) | undefined;
  /** Toggled to make a spawn (including a Task 7 retry spawn) throw instead of succeeding. */
  let spawnShouldThrow: boolean;
  /** Toggled to make the stubbed pushService reject, to prove a push failure is swallowed. */
  let pushShouldReject: boolean;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-supervision-'));
    db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 'proj-1', provider: 'claude-code', name: 'shopify-product-rollup', workingDir: '/tmp/proj-1' });

    terminalCalls = [];
    messageCalls = [];
    removeCalls = [];
    interruptCalls = [];
    pushCalls = [];
    settledListener = undefined;
    spawnShouldThrow = false;
    pushShouldReject = false;

    const sessionStub: Partial<SessionService> = {
      list: (status?: string) => sessionsDb.list(db, status).map(rowToSession),
      create: (input: CreateSessionInput) => {
        const id = uuid();
        sessionsDb.create(db, { id, provider: input.provider, name: input.name || 'New Project', workingDir: input.workingDir });
        return rowToSession(sessionsDb.getById(db, id)!);
      },
      createTerminal: (sessionId, type, label, skipPermissions, workingDir, externalId, config) => {
        if (spawnShouldThrow) throw new Error('spawn failed');
        const id = uuid();
        terminalCalls.push({ id, sessionId, config });
        terminalsDb.create(db, { id, sessionId, type, label: label || 'term', skipPermissions, workingDir, externalId, config });
        return terminalsDb.rowToTerminal(terminalsDb.getById(db, id)!);
      },
      sendThreadMessage: (terminalId, content) => {
        messageCalls.push({ terminalId, content });
        return { transport: 'structured', droppedNonText: false };
      },
      removeTerminal: (terminalId: string) => { removeCalls.push(terminalId); },
      interrupt: (terminalId: string) => { interruptCalls.push(terminalId); return true; },
    };

    agentService = new AgentService(
      db,
      { createRunnerTerminal: () => { throw new Error('non-role path must not be used for a role schedule'); }, stopTerminal: () => {} },
      createNoopBroadcaster(),
    );

    svc = new RolesService({
      db,
      agentService,
      sessionService: sessionStub as unknown as SessionService,
      rolesRoot: tmp,
      pushService: {
        notifyThread: async (input) => {
          if (pushShouldReject) throw new Error('push down');
          pushCalls.push(input);
        },
      },
    });
    agentService.setRoleRunner(svc);

    const fakeStatusService = {
      addThreadSettledListener: (fn: (info: { terminalId: string; sessionId: string; threadStatus: ThreadStatus }) => void) => {
        settledListener = fn;
      },
    } as unknown as StatusService;
    svc.wireSettled(fakeStatusService);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function enable(): { scheduleId: string } {
    writeRole(tmp, 'x', roleMd());
    const entry = svc.enable('x');
    return { scheduleId: entry.scheduleId! };
  }

  function fire(scheduleId: string): { runId: string; terminalId: string } {
    const run = agentService.runNow(scheduleId);
    return { runId: run.id, terminalId: run.terminalId! };
  }

  function setLastOutcome(terminalId: string, lastOutcome: Record<string, unknown>): void {
    const existing = JSON.parse(terminalsDb.getById(db, terminalId)!.config || '{}');
    terminalsDb.updateConfig(db, terminalId, { ...existing, lastOutcome });
  }

  async function settleFailed(terminalId: string): Promise<void> {
    setLastOutcome(terminalId, {
      summary: '```json\n{"outcome":"failed","summary":"blew up"}\n```',
      needsHelp: false,
      inferred: false,
      at: new Date().toISOString(),
    });
    settledListener!({ terminalId, sessionId: 'proj-1', threadStatus: 'idle' });
    await flush();
  }

  async function settleOk(terminalId: string): Promise<void> {
    setLastOutcome(terminalId, {
      summary: '```json\n{"outcome":"ok","summary":"all good"}\n```',
      needsHelp: false,
      inferred: false,
      at: new Date().toISOString(),
    });
    settledListener!({ terminalId, sessionId: 'proj-1', threadStatus: 'idle' });
    await flush();
  }

  it('attempt-1 failure immediately spawns a fresh attempt-2 run against the same schedule', async () => {
    const { scheduleId } = enable();
    const { runId, terminalId } = fire(scheduleId);

    await settleFailed(terminalId);

    expect(agentsDb.getRun(db, runId)!.status).toBe('failed');
    expect(terminalCalls).toHaveLength(2); // attempt 1 + the immediate attempt-2 retry

    const runs = agentsDb.listRuns(db, { scheduleId });
    expect(runs).toHaveLength(2);
    const retry = runs.find((r) => r.id !== runId)!;
    expect(retry.attempt).toBe(2);
    expect(retry.status).toBe('working');
    expect(retry.terminal_id).toBe(terminalCalls[1].id);

    // Only one bad attempt has resolved so far — no counter movement yet.
    expect(agentsDb.getSchedule(db, scheduleId)!.consecutive_failures).toBe(0);
  });

  it('attempt-2 failure increments consecutive_failures by one without disabling after a single bad night', async () => {
    const { scheduleId } = enable();
    const { terminalId } = fire(scheduleId);
    await settleFailed(terminalId);

    const retryTerminalId = terminalCalls[1].id;
    await settleFailed(retryTerminalId);

    const schedule = agentsDb.getSchedule(db, scheduleId)!;
    expect(schedule.consecutive_failures).toBe(1);
    expect(schedule.enabled).toBe(1);
    expect(pushCalls).toHaveLength(0);
  });

  it('a bounded retry never spawns attempt 3', async () => {
    const { scheduleId } = enable();
    const { terminalId } = fire(scheduleId);
    await settleFailed(terminalId);
    const retryTerminalId = terminalCalls[1].id;
    await settleFailed(retryTerminalId);

    expect(terminalCalls).toHaveLength(2); // never a third spawn
    const runs = agentsDb.listRuns(db, { scheduleId });
    expect(runs).toHaveLength(2);
    expect(Math.max(...runs.map((r) => r.attempt))).toBe(2);
  });

  it('success on any attempt resets consecutive_failures to 0', async () => {
    const { scheduleId } = enable();
    agentsDb.setConsecutiveFailures(db, scheduleId, 1); // simulate one prior bad night

    const { terminalId } = fire(scheduleId);
    await settleOk(terminalId);

    expect(agentsDb.getSchedule(db, scheduleId)!.consecutive_failures).toBe(0);
  });

  it('success on the attempt-2 retry (after an attempt-1 failure) also resets consecutive_failures to 0', async () => {
    const { scheduleId } = enable();
    const { terminalId } = fire(scheduleId);
    await settleFailed(terminalId);

    const retryTerminalId = terminalCalls[1].id;
    await settleOk(retryTerminalId);

    expect(agentsDb.getSchedule(db, scheduleId)!.consecutive_failures).toBe(0);
  });

  it('a second consecutive bad night disables the schedule and pushes a notification', async () => {
    const { scheduleId } = enable();

    // Night 1: attempt 1 fails, attempt 2 fails -> consecutive_failures = 1.
    const night1 = fire(scheduleId);
    await settleFailed(night1.terminalId);
    await settleFailed(terminalCalls[1].id);
    expect(agentsDb.getSchedule(db, scheduleId)!.consecutive_failures).toBe(1);

    // Night 2: attempt 1 fails, attempt 2 fails -> consecutive_failures = 2 -> disable + push.
    const night2 = fire(scheduleId);
    await settleFailed(night2.terminalId);
    const night2RetryTerminalId = terminalCalls[terminalCalls.length - 1].id;
    await settleFailed(night2RetryTerminalId);

    const schedule = agentsDb.getSchedule(db, scheduleId)!;
    expect(schedule.consecutive_failures).toBe(2);
    expect(schedule.enabled).toBe(0);

    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0].title).toBe('Role disabled: x');
    expect(pushCalls[0].body).toBe('2 consecutive failed nights — re-enable with dispatch roles enable x');
    expect(pushCalls[0].sessionId).toBe('proj-1');
    expect(pushCalls[0].terminalId).toBe(night2RetryTerminalId);
  });

  it('a retry spawn that itself throws still counts as attempt 2 failing (no crash, no attempt 3)', async () => {
    const { scheduleId } = enable();
    const { terminalId } = fire(scheduleId);

    spawnShouldThrow = true;
    await settleFailed(terminalId);

    const runs = agentsDb.listRuns(db, { scheduleId });
    expect(runs).toHaveLength(2);
    const retry = runs.find((r) => r.attempt === 2)!;
    expect(retry.status).toBe('failed');
    expect(agentsDb.getSchedule(db, scheduleId)!.consecutive_failures).toBe(1);
  });

  it('sweepWallCap interrupts and fails an overdue working run, and leaves a fresh run alone', async () => {
    writeRole(tmp, 'x', roleMd({ schedule: '{"type":"daily","time":"05:30"}' })); // wallClockCapMin: 30
    const entryX = svc.enable('x');
    const overdue = fire(entryX.scheduleId!);
    // Backdate started_at well past the 30-minute cap.
    const oldStart = new Date(Date.now() - 40 * 60_000).toISOString();
    db.prepare('UPDATE agent_runs SET started_at = ? WHERE id = ?').run(oldStart, overdue.runId);

    writeRole(tmp, 'y', roleMd({ name: 'y', project: 'shopify-product-rollup' }));
    const entryY = svc.enable('y');
    const fresh = fire(entryY.scheduleId!);

    svc.sweepWallCap(new Date().toISOString());

    expect(interruptCalls).toContain(overdue.terminalId);
    expect(interruptCalls).not.toContain(fresh.terminalId);

    expect(agentsDb.getRun(db, overdue.runId)!.status).toBe('failed');
    expect(agentsDb.getRun(db, fresh.runId)!.status).toBe('working');

    // The wall-capped attempt-1 failure immediately spawned a fresh attempt-2 retry —
    // the same failure path a settled failure takes.
    const runsX = agentsDb.listRuns(db, { scheduleId: entryX.scheduleId! });
    expect(runsX).toHaveLength(2);
    expect(runsX.find((r) => r.attempt === 2)!.status).toBe('working');
  });

  it('sweepWallCap routes the capped run through closeOutRun: one log.jsonl line, the terminal archived, and a late settle guarded off', async () => {
    const { scheduleId } = enable();
    const { runId, terminalId } = fire(scheduleId);
    const oldStart = new Date(Date.now() - 40 * 60_000).toISOString();
    db.prepare('UPDATE agent_runs SET started_at = ? WHERE id = ?').run(oldStart, runId);

    svc.sweepWallCap(new Date().toISOString());

    const logPath = path.join(tmp, 'x', 'log.jsonl');
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe('failed');
    expect(lines[0].summary).toContain('wall-clock cap');

    // closeOutRun archives the interrupted runner terminal — no zombie left in the rail.
    expect(removeCalls).toContain(terminalId);
    expect(agentsDb.getRun(db, runId)!.status).toBe('failed');

    // A late settle on the now-already-failed run must not double-log (finalize guard).
    settledListener!({ terminalId, sessionId: 'proj-1', threadStatus: 'idle' });
    await flush();
    const linesAfter = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    expect(linesAfter).toHaveLength(1);

    // The wall-cap failure spawned a fresh attempt-2 retry whose seed inherits the
    // wall-cap line via the log tail (buildSeedMessage reads readRunLogTail(def.dir)).
    const retryTerminalId = terminalCalls[terminalCalls.length - 1].id;
    const retryMsg = messageCalls.find((m) => m.terminalId === retryTerminalId);
    expect(String(retryMsg?.content)).toContain('wall-clock cap');
  });

  it('sweepWallCap falls back to created_at when started_at is NULL (e.g. a hard daemon kill mid-spawn), so the run still eventually caps', () => {
    const { scheduleId } = enable();
    const oldCreated = new Date(Date.now() - 40 * 60_000).toISOString();
    const stuck = agentsDb.createRun(db, {
      id: uuid(),
      scheduleId,
      projectId: 'proj-1',
      terminalId: null,
      provider: 'claude-code',
      promptSnapshot: '',
      status: 'starting',
      error: null,
      externalSessionId: null,
    });
    // createRun leaves started_at NULL until an updateRunStatus transition sets it — a
    // hard kill right after createRun (before that transition) leaves it NULL forever.
    db.prepare('UPDATE agent_runs SET created_at = ? WHERE id = ?').run(oldCreated, stuck.id);
    expect(agentsDb.getRun(db, stuck.id)!.started_at).toBeNull();

    svc.sweepWallCap(new Date().toISOString());

    expect(agentsDb.getRun(db, stuck.id)!.status).toBe('failed');
  });

  it('a crashed runner (process exit with no settle) finalizes as a failed attempt and feeds the retry path', () => {
    const { scheduleId } = enable();
    const { runId, terminalId } = fire(scheduleId);

    svc.handleTerminalExit(terminalId);

    expect(agentsDb.getRun(db, runId)!.status).toBe('failed');
    expect(removeCalls).toContain(terminalId);

    const logPath = path.join(tmp, 'x', 'log.jsonl');
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe('failed');
    expect(lines[0].attempt).toBe(1);

    // Same failure path as a settled failure: attempt 1 crashing spawns a fresh attempt 2.
    const runs = agentsDb.listRuns(db, { scheduleId });
    expect(runs).toHaveLength(2);
    expect(runs.find((r) => r.attempt === 2)!.status).toBe('working');
  });

  it('handleTerminalExit is a no-op for a terminal that is not a role run', () => {
    const id = uuid();
    terminalsDb.create(db, { id, sessionId: 'proj-1', type: 'claude-code', label: 'plain chat', config: { transport: 'structured' } });
    expect(() => svc.handleTerminalExit(id)).not.toThrow();
    expect(removeCalls).not.toContain(id);
  });

  it('handleTerminalExit is a no-op for a run that already finalized via the normal settled path', async () => {
    const { scheduleId } = enable();
    const { runId, terminalId } = fire(scheduleId);
    await settleOk(terminalId);
    expect(removeCalls.filter((id) => id === terminalId)).toHaveLength(1);

    svc.handleTerminalExit(terminalId); // the process dying AFTER a clean settle, e.g. removeTerminal's own kill()
    expect(agentsDb.getRun(db, runId)!.status).toBe('succeeded');
    expect(removeCalls.filter((id) => id === terminalId)).toHaveLength(1); // not called again
  });

  it('a rejecting pushService is swallowed as best-effort — no unhandled rejection escapes the 2-night-disable path', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      pushShouldReject = true;
      const { scheduleId } = enable();

      const night1 = fire(scheduleId);
      await settleFailed(night1.terminalId);
      await settleFailed(terminalCalls[1].id);
      const night2 = fire(scheduleId);
      await settleFailed(night2.terminalId);
      await settleFailed(terminalCalls[terminalCalls.length - 1].id);

      // Give the rejected push promise's microtask a turn to (mis)fire before asserting.
      await flush();
      await flush();

      expect(agentsDb.getSchedule(db, scheduleId)!.enabled).toBe(0); // bookkeeping still ran
      expect(pushCalls).toHaveLength(0); // the push itself did fail, as configured
      expect(unhandled).toHaveLength(0); // ...but never as an unhandled rejection
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });
});
