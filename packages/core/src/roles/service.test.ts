import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { initSchema } from '../db/schema.js';
import * as agentsDb from '../db/agents.js';
import * as sessionsDb from '../db/sessions.js';
import { rowToSession } from '../types.js';
import { AgentService } from '../agents/service.js';
import { createNoopBroadcaster } from '../ws/events.js';
import { RolesService } from './service.js';
import type { SessionService } from '../sessions/service.js';
import type { CreateSessionInput } from '../types.js';

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
