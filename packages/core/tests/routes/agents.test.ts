import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createApp } from '../../src/server.js';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';

let db: Database.Database;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, {
    id: 'proj-1',
    provider: 'codex',
    name: 'tenex',
    workingDir: '/srv/tenex',
  });
  app = createApp({ db, skipPty: true });
});

function scheduleBody() {
  return {
    projectId: 'proj-1',
    name: 'Daily CI Fix',
    provider: 'codex',
    workingDir: '/srv/tenex',
    prompt: 'Fix CI',
    scheduleKind: 'one-shot',
    runAt: '2026-05-08T12:00:00.000Z',
    recurrenceRule: null,
    timezone: 'UTC',
    enabled: true,
    nextRunAt: '2026-05-08T12:00:00.000Z',
    defaultTerminalLabel: 'Daily CI Fix',
  };
}

describe('agent routes', () => {
  it('creates and lists schedules by project', async () => {
    const create = await request(app)
      .post('/api/agents/schedules')
      .send(scheduleBody())
      .expect(201);

    expect(create.body.projectId).toBe('proj-1');

    const list = await request(app)
      .get('/api/agents/schedules?projectId=proj-1')
      .expect(200);

    expect(list.body).toHaveLength(1);
    expect(list.body[0].name).toBe('Daily CI Fix');
  });

  it('run-now returns a run record', async () => {
    const create = await request(app)
      .post('/api/agents/schedules')
      .send(scheduleBody())
      .expect(201);

    const run = await request(app)
      .post(`/api/agents/schedules/${create.body.id}/run-now`)
      .expect(200);

    expect(run.body.scheduleId).toBe(create.body.id);
    expect(['working', 'failed']).toContain(run.body.status);
  });

  it('returns run events (steps array) and 404s unknown runs', async () => {
    const create = await request(app).post('/api/agents/schedules').send(scheduleBody()).expect(201);
    const run = await request(app).post(`/api/agents/schedules/${create.body.id}/run-now`);

    const events = await request(app).get(`/api/agents/runs/${run.body.id}/events`).expect(200);
    expect(Array.isArray(events.body.steps)).toBe(true);

    await request(app).get('/api/agents/runs/does-not-exist/events').expect(404);
  });

  it('marks run opened', async () => {
    const create = await request(app)
      .post('/api/agents/schedules')
      .send(scheduleBody())
      .expect(201);
    const run = await request(app).post(`/api/agents/schedules/${create.body.id}/run-now`);

    const opened = await request(app)
      .post(`/api/agents/runs/${run.body.id}/opened`)
      .expect(200);

    expect(opened.body.lastOpenedAt).toBeTruthy();
  });
});
