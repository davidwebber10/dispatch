import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as agentsDb from '../../src/db/agents.js';
import * as sessionsDb from '../../src/db/sessions.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, {
    id: 'proj-1',
    provider: 'codex',
    name: 'tenex',
    workingDir: '/srv/tenex',
  });
});

describe('agents db', () => {
  it('creates and lists schedules by project', () => {
    const schedule = agentsDb.createSchedule(db, {
      id: 'sch-1',
      projectId: 'proj-1',
      name: 'Daily CI Fix',
      provider: 'codex',
      workingDir: '/srv/tenex',
      prompt: 'Fix failing CI tests',
      scheduleKind: 'recurring',
      runAt: null,
      recurrenceRule: JSON.stringify({ type: 'daily', time: '08:00' }),
      timezone: 'America/Indiana/Indianapolis',
      enabled: true,
      nextRunAt: '2026-05-09T12:00:00.000Z',
      defaultTerminalLabel: 'Daily CI Fix',
    });

    expect(schedule.id).toBe('sch-1');
    expect(agentsDb.listSchedules(db, { projectId: 'proj-1' })).toHaveLength(1);
    expect(agentsDb.listSchedules(db, { projectId: 'other' })).toHaveLength(0);
  });

  it('creates runs and marks unread until opened', () => {
    agentsDb.createSchedule(db, {
      id: 'sch-1',
      projectId: 'proj-1',
      name: 'Daily CI Fix',
      provider: 'codex',
      workingDir: '/srv/tenex',
      prompt: 'Fix failing CI tests',
      scheduleKind: 'recurring',
      runAt: null,
      recurrenceRule: JSON.stringify({ type: 'daily', time: '08:00' }),
      timezone: 'America/Indiana/Indianapolis',
      enabled: true,
      nextRunAt: '2026-05-09T12:00:00.000Z',
      defaultTerminalLabel: 'Daily CI Fix',
    });

    const run = agentsDb.createRun(db, {
      id: 'run-1',
      scheduleId: 'sch-1',
      projectId: 'proj-1',
      terminalId: null,
      provider: 'codex',
      promptSnapshot: 'Fix failing CI tests',
      status: 'queued',
      error: null,
      externalSessionId: null,
    });

    expect(run.status).toBe('queued');
    agentsDb.updateRunStatus(db, 'run-1', 'succeeded', { unread: true });
    expect(agentsDb.getRun(db, 'run-1')!.unread_since).toBeTruthy();

    agentsDb.markRunOpened(db, 'run-1');
    const opened = agentsDb.getRun(db, 'run-1')!;
    expect(opened.last_opened_at).toBeTruthy();
    expect(opened.unread_since).toBeNull();
  });

  it('claims due schedules without returning disabled schedules', () => {
    agentsDb.createSchedule(db, {
      id: 'due-1',
      projectId: 'proj-1',
      name: 'Due',
      provider: 'claude-code',
      workingDir: '/srv/tenex',
      prompt: 'Run now',
      scheduleKind: 'one-shot',
      runAt: '2026-05-08T12:00:00.000Z',
      recurrenceRule: null,
      timezone: 'UTC',
      enabled: true,
      nextRunAt: '2026-05-08T12:00:00.000Z',
      defaultTerminalLabel: 'Due',
    });
    agentsDb.createSchedule(db, {
      id: 'disabled-1',
      projectId: 'proj-1',
      name: 'Disabled',
      provider: 'codex',
      workingDir: '/srv/tenex',
      prompt: 'Do not run',
      scheduleKind: 'one-shot',
      runAt: '2026-05-08T12:00:00.000Z',
      recurrenceRule: null,
      timezone: 'UTC',
      enabled: false,
      nextRunAt: '2026-05-08T12:00:00.000Z',
      defaultTerminalLabel: 'Disabled',
    });

    const due = agentsDb.listDueSchedules(db, '2026-05-08T12:01:00.000Z');
    expect(due.map(s => s.id)).toEqual(['due-1']);
  });
});
