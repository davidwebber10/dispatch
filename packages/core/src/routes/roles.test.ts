import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRolesRouter } from './roles.js';
import type { RolesService, RoleStatusEntry } from '../roles/service.js';
import type { RoleDefinition } from '../roles/definition.js';

function def(overrides: Partial<RoleDefinition> = {}): RoleDefinition {
  return {
    name: 'x', dir: '/roles/x', project: 'proj', global: false, agentType: 'researcher',
    schedule: { type: 'daily', time: '05:30' }, authority: 'stage', wallClockCapMin: 30,
    brief: 'This is the secret brief body that should never hit the wire.',
    ...overrides,
  };
}

function app(stub: Partial<RolesService>) {
  const a = express();
  a.use(express.json());
  a.use('/api/roles', createRolesRouter(stub as unknown as RolesService));
  return a;
}

function statusErr(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

describe('GET /api/roles', () => {
  it('lists entries with the brief body stripped', async () => {
    const entry: RoleStatusEntry = { def: def(), enabled: false };
    const res = await request(app({ list: () => [entry] })).get('/api/roles');
    expect(res.status).toBe(200);
    expect(res.body.roles).toHaveLength(1);
    expect(res.body.roles[0].def.name).toBe('x');
    expect(res.body.roles[0].def.brief).toBeUndefined();
    expect(res.body.roles[0].enabled).toBe(false);
  });
});

describe('POST /api/roles/:name/enable', () => {
  it('returns the updated entry on success', async () => {
    const entry: RoleStatusEntry = { def: def(), enabled: true, scheduleId: 's1', nextRunAt: '2026-09-03T05:30:00.000Z' };
    const res = await request(app({ enable: () => entry })).post('/api/roles/x/enable');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.scheduleId).toBe('s1');
  });

  it('404s on an unknown role', async () => {
    const res = await request(app({ enable: () => { throw statusErr(404, 'role "missing" not found'); } }))
      .post('/api/roles/missing/enable');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/);
  });

  it('400s with the parse message on an invalid role', async () => {
    const res = await request(app({ enable: () => { throw statusErr(400, 'role.md must start with a --- frontmatter block'); } }))
      .post('/api/roles/broken/enable');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/frontmatter/);
  });
});

describe('POST /api/roles/:name/disable', () => {
  it('returns the updated entry on success', async () => {
    const entry: RoleStatusEntry = { def: def(), enabled: false, scheduleId: 's1' };
    const res = await request(app({ disable: () => entry })).post('/api/roles/x/disable');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.scheduleId).toBe('s1');
  });

  it('404s on an unknown role', async () => {
    const res = await request(app({ disable: () => { throw statusErr(404, 'role "missing" not found'); } }))
      .post('/api/roles/missing/disable');
    expect(res.status).toBe(404);
  });
});
