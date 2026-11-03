import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as integrationsDb from '../db/integrations.js';
import * as agentsDb from '../db/agents.js';
import { AgentService } from '../agents/service.js';
import { IntegrationsService } from '../integrations/service.js';
import { createIntegrationsRouter } from '../routes/integrations.js';
import { createAgentsRouter } from '../routes/agents.js';
import { createRolesRouter } from '../routes/roles.js';
import type { RolesService } from '../roles/service.js';
import { KeyRegistry } from './principals.js';
import type { CallerFacts, KeyScope } from './key-scope.js';
import { nullKeyScope } from './key-scope.js';
import { createPrincipalMiddleware } from './request-principal.js';
import { creatorOf, decodeCreator, encodeCreator } from './creator.js';

const TOKEN = 'owner-token-for-the-creator-tests';
const facts = (over: Partial<CallerFacts> = {}): CallerFacts => ({
  id: 'term-7', sessionId: 'proj-1', type: 'claude-code', role: null, depth: 0, spawnedBy: null,
  origin: null, roleRun: false, archived: false, overseer: false, label: 'Fix the login bug', ...over,
});
const scope: KeyScope = {
  ...nullKeyScope,
  caller: (id) => (id === 'term-7' ? facts() : id === 'term-run' ? facts({ id: 'term-run', roleRun: true, label: 'Nightly run' }) : null),
};

let db: Database.Database;
let registry: KeyRegistry;
let rolesCalls: unknown[];
let appInstance: express.Express;

const scheduleBody = (over: Record<string, unknown> = {}) => ({
  projectId: 'proj-1', name: 'Nightly', provider: 'claude-code', workingDir: '/srv/x', prompt: 'do it',
  scheduleKind: 'recurring', runAt: null, recurrenceRule: JSON.stringify({ type: 'daily', time: '05:30' }),
  timezone: 'UTC', enabled: true, nextRunAt: null, defaultTerminalLabel: null, ...over,
});

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 'proj-1', provider: 'claude-code', name: 'proj', workingDir: '/srv/x' } as any);
  registry = new KeyRegistry();
  rolesCalls = [];
  const agents = new AgentService(db, { createRunnerTerminal: vi.fn(), stopTerminal: vi.fn() } as any, { broadcast: vi.fn() } as any);
  const roles = {
    enable: (name: string, by: unknown) => { rolesCalls.push(by); return { def: { name, brief: 'b' }, enabled: true }; },
    list: () => [],
  } as unknown as RolesService;
  appInstance = express();
  appInstance.use(express.json());
  appInstance.use(createPrincipalMiddleware({ registry, scope, getToken: () => TOKEN, log: () => {} }));
  appInstance.use('/api/integrations', createIntegrationsRouter(new IntegrationsService(db)));
  appInstance.use('/api/agents', createAgentsRouter(agents));
  appInstance.use('/api/roles', createRolesRouter(roles));
});

const owner = { Authorization: `Bearer ${TOKEN}` };
const stdio = (name: string, extra: Record<string, unknown> = {}) => ({ type: 'stdio', name, command: 'echo', args: [], ...extra });

describe('creatorOf', () => {
  it('names the owner for a request with the access token', async () => {
    const res = await request(appInstance).post('/api/integrations').set(owner).send(stdio('one'));
    expect(res.status).toBe(200);
    expect(res.body.createdBy).toEqual({ kind: 'owner' });
  });

  it('names a local caller with no sign-in', async () => {
    const res = await request(appInstance).post('/api/integrations').send(stdio('one'));
    expect(res.body.createdBy).toEqual({ kind: 'local' });
  });

  it('names the thread, with its id and name, for a request with a thread key', async () => {
    const { key } = registry.mint({ kind: 'thread', terminalId: 'term-7' });
    const seen: unknown[] = [];
    const a = express();
    a.use(createPrincipalMiddleware({ registry, scope, getToken: () => TOKEN, log: () => {} }));
    a.get('/api/who', (req, res) => { seen.push(creatorOf(req)); res.end(); });
    await request(a).get('/api/who').set('Authorization', `Bearer ${key}`);
    expect(seen).toEqual([{ kind: 'thread', terminalId: 'term-7', name: 'Fix the login bug' }]);
  });

  it('counts a request that no middleware tagged as local', () => {
    expect(creatorOf({ headers: {} } as any)).toEqual({ kind: 'local' });
  });
});

describe('encode and decode', () => {
  it('round-trips each kind', () => {
    for (const c of [{ kind: 'owner' }, { kind: 'local' }, { kind: 'tailscale' }, { kind: 'chat' }, { kind: 'thread', terminalId: 't', name: 'N' }, { kind: 'shell', terminalId: 't', name: null }] as const) {
      expect(decodeCreator(encodeCreator(c))).toEqual(c);
    }
  });
  it('reads nothing, bad JSON and unknown kinds as unknown', () => {
    for (const raw of [null, undefined, '', 'not json', '{"kind":"alien"}', '{"kind":"thread"}', '42', 'null']) expect(decodeCreator(raw as any)).toBeNull();
  });
});

describe('POST /api/integrations records the creator', () => {
  it('stores it, lists it, and ignores a creator written in the body', async () => {
    await request(appInstance).post('/api/integrations').send(stdio('one', { createdBy: { kind: 'owner' } }));
    const list = await request(appInstance).get('/api/integrations').set(owner);
    expect(list.body.integrations[0].createdBy).toEqual({ kind: 'local' });
  });

  it('records the importer for an imported integration', async () => {
    const res = await request(appInstance).post('/api/integrations/import').set(owner)
      .send({ version: 1, integrations: [{ ...stdio('imp'), env: {}, enabled: true }] });
    expect(res.body.added).toEqual(['imp']);
    expect(integrationsDb.list(db)[0].createdBy).toEqual({ kind: 'owner' });
  });

  it('keeps the creator out of an export', async () => {
    await request(appInstance).post('/api/integrations').set(owner).send(stdio('one'));
    const res = await request(appInstance).get('/api/integrations/export').set(owner);
    expect(res.body.integrations[0]).not.toHaveProperty('createdBy');
  });

  it('shows a row from before the record as unknown (null)', () => {
    db.prepare(`INSERT INTO integrations (id, name, type, command, enabled, created_at, updated_at) VALUES ('old','old','stdio','echo',1,'x','x')`).run();
    expect(integrationsDb.getById(db, 'old')!.createdBy).toBeNull();
  });

  it('lets a thread with its own key create one, and records the thread name', async () => {
    const { key } = registry.mint({ kind: 'thread', terminalId: 'term-7' });
    const res = await request(appInstance).post('/api/integrations').set('Authorization', `Bearer ${key}`).send(stdio('one'));
    expect(res.status).toBe(200);
    expect(res.body.createdBy).toEqual({ kind: 'thread', terminalId: 'term-7', name: 'Fix the login bug' });
    expect(integrationsDb.list(db)[0].createdBy).toEqual({ kind: 'thread', terminalId: 'term-7', name: 'Fix the login bug' });
  });

  it('keeps the other integration routes owner only for a thread key', async () => {
    const { key } = registry.mint({ kind: 'thread', terminalId: 'term-7' });
    const auth = { Authorization: `Bearer ${key}` };
    const made = await request(appInstance).post('/api/integrations').set(owner).send(stdio('one'));
    const id = made.body.id;
    for (const r of [
      request(appInstance).patch(`/api/integrations/${id}`).set(auth).send({ enabled: false }),
      request(appInstance).delete(`/api/integrations/${id}`).set(auth),
      request(appInstance).post('/api/integrations/import').set(auth).send({ version: 1, integrations: [] }),
      request(appInstance).get('/api/integrations/export').set(auth),
    ]) expect((await r).status).toBe(403);
    expect(integrationsDb.list(db)).toHaveLength(1);
  });

  it('still refuses a role-run key, a shell key and a Chat key', async () => {
    const keys = [
      registry.mint({ kind: 'thread', terminalId: 'term-run' }).key,
      registry.mint({ kind: 'shell', terminalId: 'term-7' }).key,
      registry.mint({ kind: 'chat', startedBy: 'user' }).key,
    ];
    for (const key of keys) {
      const res = await request(appInstance).post('/api/integrations').set('Authorization', `Bearer ${key}`).send(stdio('x'));
      expect(res.status).toBe(403);
    }
    expect(integrationsDb.list(db)).toEqual([]);
  });
});

describe('POST /api/agents/schedules records the creator', () => {
  it('stores it, returns it, and ignores a creator written in the body', async () => {
    const res = await request(appInstance).post('/api/agents/schedules').set(owner).send(scheduleBody({ createdBy: { kind: 'chat' } }));
    expect(res.status).toBe(201);
    expect(res.body.createdBy).toEqual({ kind: 'owner' });
    const got = await request(appInstance).get(`/api/agents/schedules/${res.body.id}`).set(owner);
    expect(got.body.createdBy).toEqual({ kind: 'owner' });
  });

  it('lets a thread with its own key create one, and records the thread name', async () => {
    const { key } = registry.mint({ kind: 'thread', terminalId: 'term-7' });
    const res = await request(appInstance).post('/api/agents/schedules').set('Authorization', `Bearer ${key}`).send(scheduleBody());
    expect(res.status).toBe(201);
    expect(res.body.createdBy).toEqual({ kind: 'thread', terminalId: 'term-7', name: 'Fix the login bug' });
  });

  it('keeps the other schedule routes owner only for a thread key, and refuses a role-run key', async () => {
    const { key } = registry.mint({ kind: 'thread', terminalId: 'term-7' });
    const auth = { Authorization: `Bearer ${key}` };
    const made = await request(appInstance).post('/api/agents/schedules').set(owner).send(scheduleBody());
    expect((await request(appInstance).patch(`/api/agents/schedules/${made.body.id}`).set(auth).send({ name: 'x' })).status).toBe(403);
    expect((await request(appInstance).delete(`/api/agents/schedules/${made.body.id}`).set(auth)).status).toBe(403);
    const run = registry.mint({ kind: 'thread', terminalId: 'term-run' }).key;
    expect((await request(appInstance).post('/api/agents/schedules').set('Authorization', `Bearer ${run}`).send(scheduleBody())).status).toBe(403);
  });

  it('a schedule edit does not change the creator', async () => {
    const made = await request(appInstance).post('/api/agents/schedules').send(scheduleBody());
    const edited = await request(appInstance).patch(`/api/agents/schedules/${made.body.id}`).set(owner).send({ name: 'Renamed', createdBy: { kind: 'owner' } });
    expect(edited.status).toBe(200);
    expect(edited.body.createdBy).toEqual({ kind: 'local' });
  });

  it('shows a schedule from before the record as unknown (null)', async () => {
    agentsDb.createSchedule(db, { id: 'old', projectId: 'proj-1', name: 'Old', provider: 'claude-code', workingDir: '/x', prompt: 'p', scheduleKind: 'one-shot', runAt: null, recurrenceRule: null, timezone: 'UTC', enabled: false, nextRunAt: null, defaultTerminalLabel: null });
    const got = await request(appInstance).get('/api/agents/schedules/old').set(owner);
    expect(got.body.createdBy).toBeNull();
  });
});

describe('POST /api/roles/:name/enable records the creator', () => {
  it('passes the creator of the request to the roles service', async () => {
    await request(appInstance).post('/api/roles/x/enable').set(owner);
    await request(appInstance).post('/api/roles/x/enable');
    expect(rolesCalls).toEqual([{ kind: 'owner' }, { kind: 'local' }]);
  });
});

describe('thread keys on the roles route', () => {
  it('lets a thread enable a role (recorded by name), but not disable one', async () => {
    const { key } = registry.mint({ kind: 'thread', terminalId: 'term-7' });
    const auth = { Authorization: `Bearer ${key}` };
    expect((await request(appInstance).post('/api/roles/x/enable').set(auth)).status).toBe(200);
    expect(rolesCalls).toEqual([{ kind: 'thread', terminalId: 'term-7', name: 'Fix the login bug' }]);
    expect((await request(appInstance).post('/api/roles/x/disable').set(auth)).status).toBe(403);
  });

  it('refuses a role-run key', async () => {
    const run = registry.mint({ kind: 'thread', terminalId: 'term-run' }).key;
    expect((await request(appInstance).post('/api/roles/x/enable').set('Authorization', `Bearer ${run}`)).status).toBe(403);
    expect(rolesCalls).toEqual([]);
  });
});

describe('migration 013', () => {
  it('adds created_by to both tables and can run again', () => {
    initSchema(db);
    for (const t of ['integrations', 'agent_schedules']) {
      expect((db.pragma(`table_info(${t})`) as { name: string }[]).some((c) => c.name === 'created_by')).toBe(true);
    }
  });
});
