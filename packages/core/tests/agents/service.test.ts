import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as agentsDb from '../../src/db/agents.js';
import { AgentService } from '../../src/agents/service.js';

const claudeFixture = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/claude-stream.jsonl'),
  'utf8',
);

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
    createRunnerTerminal: vi.fn((sessionId, type, label, workingDir, prompt) => {
      terminalsDb.create(db, {
        id: 'term-1',
        sessionId,
        type,
        label,
        skipPermissions: true,
        workingDir,
        config: { runner: true, runnerPrompt: prompt },
      });
      return terminalsDb.rowToTerminal(terminalsDb.getById(db, 'term-1')!);
    }),
    stopTerminal: vi.fn(),
  };
  broadcaster = { broadcast: vi.fn() };
});

describe('AgentService', () => {
  it('runNow launches an autonomous runner terminal with the prompt (no typed-in prompt)', () => {
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
    expect(run.status).toBe('working');
    // The prompt is passed as a launch arg to the runner — not typed into a TUI.
    expect(sessionService.createRunnerTerminal).toHaveBeenCalledWith(
      'proj-1',
      'codex',
      'Daily CI Fix',
      '/srv/tenex',
      'Fix CI',
    );
    expect(broadcaster.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent:run-created' }));
  });

  it('handleTerminalExit marks the run succeeded on a clean (0) exit', () => {
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
    service.runNow(schedule.id);

    const finished = service.handleTerminalExit('term-1', 0)!;
    expect(finished.status).toBe('succeeded');
    expect(finished.completedAt).toBeTruthy();
    expect(finished.error).toBeNull();
    expect(broadcaster.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent:run-updated' }));
  });

  it('handleTerminalExit marks the run failed on a non-zero exit', () => {
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
    service.runNow(schedule.id);

    const finished = service.handleTerminalExit('term-1', 1)!;
    expect(finished.status).toBe('failed');
    expect(finished.completedAt).toBeTruthy();
    expect(finished.error).toContain('1');
  });

  it('handleTerminalExit does not override an already-cancelled run', () => {
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
    const run = service.runNow(schedule.id);
    service.cancelRun(run.id);

    // The cancel killed the PTY, which later fires exit — must stay cancelled.
    expect(service.handleTerminalExit('term-1', 1)).toBeNull();
    expect(service.getRun(run.id)!.status).toBe('cancelled');
  });

  it('handleTerminalExit is a no-op for a terminal with no run', () => {
    const service = new AgentService(db, sessionService, broadcaster);
    expect(service.handleTerminalExit('no-such-terminal', 0)).toBeNull();
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

  it('streams structured steps and finalizes the run with telemetry from stream-json', () => {
    const service = new AgentService(db, sessionService, broadcaster);
    const schedule = service.createSchedule({
      projectId: 'proj-1', name: 'Claude Run', provider: 'claude-code', workingDir: '/srv/tenex',
      prompt: 'go', scheduleKind: 'one-shot', runAt: '2026-05-08T12:00:00.000Z', recurrenceRule: null,
      timezone: 'UTC', enabled: true, nextRunAt: null, defaultTerminalLabel: 'Claude Run',
    });
    const run = service.runNow(schedule.id);

    // Feed the real captured stream-json output for this run's terminal.
    service.onRunnerData('term-1', claudeFixture);

    // Live structured steps were broadcast (e.g. the Write tool call).
    const stepEvents = broadcaster.broadcast.mock.calls
      .map((c) => c[0])
      .filter((e: any) => e.type === 'agent:run-step');
    expect(stepEvents.length).toBeGreaterThan(0);
    expect(stepEvents.some((e: any) => e.step.kind === 'tool-use' && e.step.title.startsWith('Write'))).toBe(true);

    // The parsed `result` event finalized the run with cost/tokens (before exit).
    const finished = service.getRun(run.id)!;
    expect(finished.status).toBe('succeeded');
    expect(finished.costUsd!).toBeGreaterThan(0);
    expect(finished.totalTokens!).toBeGreaterThan(0);
    expect(finished.numTurns).toBe(3);
    expect(finished.model).toBe('claude-opus-4-8[1m]');
    expect(finished.resultText).toContain('hello.txt');

    // A subsequent process exit must NOT override the already-finalized run.
    expect(service.handleTerminalExit('term-1', 0)).toBeNull();
    expect(service.getRun(run.id)!.status).toBe('succeeded');
  });

  it('getRunSteps re-parses a persisted transcript into timeline + activity steps', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-runs-'));
    const service = new AgentService(db, sessionService, broadcaster, dir);
    const schedule = service.createSchedule({
      projectId: 'proj-1', name: 'Claude Run', provider: 'claude-code', workingDir: '/srv/tenex',
      prompt: 'go', scheduleKind: 'one-shot', runAt: '2026-05-08T12:00:00.000Z', recurrenceRule: null,
      timezone: 'UTC', enabled: true, nextRunAt: null, defaultTerminalLabel: 'Claude Run',
    });
    const run = service.runNow(schedule.id);
    service.onRunnerData('term-1', claudeFixture);
    service.handleTerminalExit('term-1', 0); // closes the transcript stream

    const steps = service.getRunSteps(run.id);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.some((s) => s.kind === 'tool-use')).toBe(true);
    expect(steps.some((s) => s.kind === 'result')).toBe(true);
    expect(steps.filter((s) => s.timeline).length).toBeGreaterThan(0);

    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
