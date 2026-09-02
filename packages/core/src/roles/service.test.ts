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
