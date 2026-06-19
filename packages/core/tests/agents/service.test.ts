import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as agentsDb from '../../src/db/agents.js';
import { AgentService } from '../../src/agents/service.js';

let db: Database.Database;
let sessionService: any;
let broadcaster: { broadcast: ReturnType<typeof vi.fn> };

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, {
    id: 'proj-1',
    provider: 'codex',
    name: 'tenex',
    workingDir: '/srv/tenex',
  });
  sessionService = {
    createTerminal: vi.fn((sessionId, type, label, skipPermissions, workingDir, externalId) => {
      terminalsDb.create(db, {
        id: 'term-1',
        sessionId,
        type,
        label,
        skipPermissions,
        workingDir,
        externalId,
      });
      return terminalsDb.rowToTerminal(terminalsDb.getById(db, 'term-1')!);
    }),
    stopTerminal: vi.fn(),
    writeToTerminal: vi.fn(),
  };
  broadcaster = { broadcast: vi.fn() };
});

describe('AgentService', () => {
  it('runNow creates a run, creates a terminal on the server, and injects the prompt', () => {
    const service = new AgentService(db, sessionService, broadcaster);
    const schedule = service.createSchedule({
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
    });

    const run = service.runNow(schedule.id);

    expect(run.terminalId).toBe('term-1');
    expect(sessionService.createTerminal).toHaveBeenCalledWith(
      'proj-1',
      'codex',
      'Daily CI Fix',
      false,
      '/srv/tenex',
      undefined,
    );
    expect(sessionService.writeToTerminal).toHaveBeenCalledWith('term-1', 'Fix CI\r');
    expect(broadcaster.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent:run-created' }));
  });

  it('processDueRuns dispatches each due schedule once', () => {
    const service = new AgentService(db, sessionService, broadcaster);
    const s = service.createSchedule({
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
    });
    // The server (re)computes next_run_at; force it to the fixed-time fixture so it's due.
    agentsDb.updateSchedule(db, s.id, { enabled: true, nextRunAt: '2026-05-08T12:00:00.000Z' });

    expect(service.processDueRuns('2026-05-08T12:01:00.000Z')).toHaveLength(1);
    expect(service.processDueRuns('2026-05-08T12:02:00.000Z')).toHaveLength(0);
  });

  it('processDueRuns advances recurring schedule nextRunAt', () => {
    const service = new AgentService(db, sessionService, broadcaster);
    const schedule = service.createSchedule({
      projectId: 'proj-1',
      name: 'Daily CI Fix',
      provider: 'codex',
      workingDir: '/srv/tenex',
      prompt: 'Fix CI',
      scheduleKind: 'recurring',
      runAt: null,
      recurrenceRule: JSON.stringify({ type: 'daily', time: '08:00' }),
      timezone: 'UTC',
      enabled: true,
      nextRunAt: '2026-05-08T08:00:00.000Z',
      defaultTerminalLabel: 'Daily CI Fix',
    });
    // Force the fixed-time fixture so it's due (server otherwise computes from real now).
    agentsDb.updateSchedule(db, schedule.id, { enabled: true, nextRunAt: '2026-05-08T08:00:00.000Z' });

    expect(service.processDueRuns('2026-05-08T08:01:00.000Z')).toHaveLength(1);

    const updated = service.getSchedule(schedule.id)!;
    expect(updated.enabled).toBe(true);
    expect(updated.nextRunAt).toBe('2026-05-09T08:00:00.000Z');
  });

  it('cancelRun stops the server terminal and marks run cancelled unread', () => {
    const service = new AgentService(db, sessionService, broadcaster);
    const schedule = service.createSchedule({
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
    });
    const run = service.runNow(schedule.id);

    const cancelled = service.cancelRun(run.id);

    expect(sessionService.stopTerminal).toHaveBeenCalledWith('term-1');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.unreadSince).toBeTruthy();
  });

  it('deleteSchedule removes a schedule that has runs and stops its terminals', () => {
    const service = new AgentService(db, sessionService, broadcaster);
    const schedule = service.createSchedule({
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
      nextRunAt: null,
      defaultTerminalLabel: 'Daily CI Fix',
    });
    service.runNow(schedule.id); // creates a run + terminal referencing the schedule

    expect(service.deleteSchedule(schedule.id)).toBe(true);
    expect(sessionService.stopTerminal).toHaveBeenCalledWith('term-1');
    expect(service.getSchedule(schedule.id)).toBeNull();
    expect(service.listRuns({ scheduleId: schedule.id })).toHaveLength(0);
  });
});
