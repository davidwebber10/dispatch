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
import { StatusService } from '../../src/status/service.js';
import { summary } from '../../src/analytics/queries.js';
import { attachPtyCapture } from '../../src/analytics/pty-capture.js';
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

  it('refuses to create or change a schedule that runs more often than once a minute (SEC-23)', () => {
    const service = new AgentService(db, sessionService, broadcaster);
    const base = { projectId: 'proj-1', name: 'Poller', provider: 'codex', workingDir: '/srv/tenex', prompt: 'p', scheduleKind: 'recurring' as const, runAt: null, timezone: 'UTC', enabled: true, nextRunAt: null, defaultTerminalLabel: null };
    expect(() => service.createSchedule({ ...base, recurrenceRule: JSON.stringify({ type: 'interval', everyMinutes: 0.01 }) })).toThrow(/shortest allowed gap/);
    const ok = service.createSchedule({ ...base, recurrenceRule: JSON.stringify({ type: 'interval', everyMinutes: 30 }) });
    expect(() => service.updateSchedule(ok.id, { recurrenceRule: JSON.stringify({ type: 'interval', everyMinutes: 0.01 }) })).toThrow(/shortest allowed gap/);
    expect(service.updateSchedule(ok.id, { enabled: false })?.enabled).toBe(false); // other changes still work
    // A stored schedule shorter than a raised minimum can still be renamed (the edit form sends the same rule again).
    const prevMin = process.env.DISPATCH_MIN_SCHEDULE_MINUTES;
    const fast = service.createSchedule({ ...base, name: 'Fast', recurrenceRule: JSON.stringify({ type: 'interval', everyMinutes: 1 }) });
    process.env.DISPATCH_MIN_SCHEDULE_MINUTES = '5';
    try {
      expect(service.updateSchedule(fast.id, { name: 'Fast 2', recurrenceRule: fast.recurrenceRule })?.name).toBe('Fast 2');
      // The same rule written another way (spacing, key order) is still the same rule.
      expect(service.updateSchedule(fast.id, { name: 'Fast 3', recurrenceRule: '{ "everyMinutes": 1, "type": "interval" }' })?.name).toBe('Fast 3');
      expect(() => service.updateSchedule(fast.id, { recurrenceRule: JSON.stringify({ type: 'interval', everyMinutes: 2 }) })).toThrow(/shortest allowed gap/);
    } finally { if (prevMin === undefined) delete process.env.DISPATCH_MIN_SCHEDULE_MINUTES; else process.env.DISPATCH_MIN_SCHEDULE_MINUTES = prevMin; }
  });

  describe('the schedule floor cannot be bypassed (SEC-23)', () => {
    const base = { projectId: 'proj-1', name: 'Poller', provider: 'codex' as const, workingDir: '/srv/tenex', prompt: 'p', runAt: null, timezone: 'UTC', enabled: true, nextRunAt: null, defaultTerminalLabel: null };
    const everyMinute = JSON.stringify({ type: 'cron', expr: '* * * * *' });
    const withMin = (value: string | undefined, fn: () => void) => {
      const prev = process.env.DISPATCH_MIN_SCHEDULE_MINUTES;
      if (value === undefined) delete process.env.DISPATCH_MIN_SCHEDULE_MINUTES; else process.env.DISPATCH_MIN_SCHEDULE_MINUTES = value;
      try { fn(); } finally { if (prev === undefined) delete process.env.DISPATCH_MIN_SCHEDULE_MINUTES; else process.env.DISPATCH_MIN_SCHEDULE_MINUTES = prev; }
    };

    it('refuses a one-shot that is created with a rule below the minimum, and still allows a real one-shot', () => {
      const service = new AgentService(db, sessionService, broadcaster);
      withMin('5', () => {
        expect(() => service.createSchedule({ ...base, scheduleKind: 'one-shot', runAt: '2099-01-01T00:00:00.000Z', recurrenceRule: everyMinute })).toThrow(/DISPATCH_MIN_SCHEDULE_MINUTES/);
        const once = service.createSchedule({ ...base, scheduleKind: 'one-shot', runAt: '2099-01-01T00:00:00.000Z', recurrenceRule: null });
        expect(once.enabled).toBe(true);
        expect(once.nextRunAt).toBe('2099-01-01T00:00:00.000Z');
      });
    });

    it('refuses to turn a one-shot into a recurring schedule when the stored rule is below the minimum', () => {
      const service = new AgentService(db, sessionService, broadcaster);
      // Stored while the floor was off, so the bad rule is on a one-shot (the repro of the bypass).
      let id = '';
      withMin('0', () => { id = service.createSchedule({ ...base, scheduleKind: 'one-shot', runAt: '2099-01-01T00:00:00.000Z', recurrenceRule: everyMinute, enabled: false }).id; });
      withMin('5', () => {
        expect(() => service.updateSchedule(id, { scheduleKind: 'recurring', enabled: true })).toThrow(/DISPATCH_MIN_SCHEDULE_MINUTES/);
        expect(() => service.updateSchedule(id, { scheduleKind: 'recurring' })).toThrow(/shortest allowed gap/);
        expect(service.getSchedule(id)?.scheduleKind).toBe('one-shot');
        // A sparse rule is fine, and so is a rename of the one-shot.
        expect(service.updateSchedule(id, { name: 'Renamed' })?.name).toBe('Renamed');
        const ok = service.updateSchedule(id, { scheduleKind: 'recurring', recurrenceRule: JSON.stringify({ type: 'cron', expr: '*/10 * * * *' }), enabled: true });
        expect(ok?.scheduleKind).toBe('recurring');
      });
    });

    it('refuses a kind change that brings a too-fast rule in the same request', () => {
      const service = new AgentService(db, sessionService, broadcaster);
      withMin('5', () => {
        const once = service.createSchedule({ ...base, scheduleKind: 'one-shot', runAt: '2099-01-01T00:00:00.000Z', recurrenceRule: null });
        expect(() => service.updateSchedule(once.id, { scheduleKind: 'recurring', recurrenceRule: everyMinute })).toThrow(/shortest allowed gap/);
        expect(() => service.updateSchedule(once.id, { recurrenceRule: everyMinute })).toThrow(/shortest allowed gap/);
        expect(service.getSchedule(once.id)?.recurrenceRule).toBeNull();
      });
    });

    it('refuses to switch on a stored schedule that is below the minimum, but switching off and renaming still work', () => {
      const service = new AgentService(db, sessionService, broadcaster);
      let id = '';
      withMin('1', () => { id = service.createSchedule({ ...base, scheduleKind: 'recurring', recurrenceRule: everyMinute, enabled: false }).id; });
      withMin('5', () => {
        expect(() => service.updateSchedule(id, { enabled: true })).toThrow(/DISPATCH_MIN_SCHEDULE_MINUTES/);
        expect(service.getSchedule(id)?.enabled).toBe(false);
        expect(service.updateSchedule(id, { name: 'Renamed' })?.name).toBe('Renamed');
      });
      withMin('1', () => { expect(service.updateSchedule(id, { enabled: true })?.enabled).toBe(true); });
      withMin('5', () => { expect(service.updateSchedule(id, { enabled: false })?.enabled).toBe(false); });
    });

    it('keeps a genuine one-shot working with no rule at all', () => {
      const service = new AgentService(db, sessionService, broadcaster);
      withMin('5', () => {
        const once = service.createSchedule({ ...base, scheduleKind: 'one-shot', runAt: '2099-01-01T00:00:00.000Z', recurrenceRule: null });
        expect(service.updateSchedule(once.id, { runAt: '2099-02-01T00:00:00.000Z', enabled: false })?.enabled).toBe(false);
        expect(service.updateSchedule(once.id, { enabled: true })?.nextRunAt).toBe('2099-02-01T00:00:00.000Z');
      });
    });
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
    expect(db.prepare('SELECT outcome FROM usage_turns').get()).toEqual({ outcome: 'error' });
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

  it('processDueRuns holds a stored dense cron to the floor, counted from the run that just fired', () => {
    const service = new AgentService(db, sessionService, broadcaster);
    const prev = process.env.DISPATCH_MIN_SCHEDULE_MINUTES;
    try {
      process.env.DISPATCH_MIN_SCHEDULE_MINUTES = '0';
      const s = service.createSchedule({
        projectId: 'proj-1', name: 'Dense', provider: 'codex', workingDir: '/srv/tenex', prompt: 'p',
        scheduleKind: 'recurring', runAt: null, recurrenceRule: JSON.stringify({ type: 'cron', expr: '0,1 * * * *' }),
        timezone: 'UTC', enabled: true, nextRunAt: null, defaultTerminalLabel: null,
      });
      agentsDb.updateSchedule(db, s.id, { enabled: true, nextRunAt: '2026-05-08T12:00:00.000Z' });
      process.env.DISPATCH_MIN_SCHEDULE_MINUTES = '5';
      expect(service.processDueRuns('2026-05-08T12:00:20.000Z')).toHaveLength(1);
      expect(service.getSchedule(s.id)?.nextRunAt).toBe('2026-05-08T13:00:00.000Z');
    } finally { if (prev === undefined) delete process.env.DISPATCH_MIN_SCHEDULE_MINUTES; else process.env.DISPATCH_MIN_SCHEDULE_MINUTES = prev; }
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

    // PTY exit capture must leave this row open for the runner parser to flush.
    attachPtyCapture({ db, isStructured: () => false })({ terminalId: 'term-1', sessionId: 'proj-1', phase: 'end', threadStatus: 'done' });
    expect((db.prepare('SELECT ended_at FROM usage_turns').get() as any).ended_at).toBeNull();

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
    const result = JSON.parse(claudeFixture.trim().split('\n').at(-1)!);
    expect(summary(db, {})).toMatchObject({
      turns: 1, inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens,
      cacheReadTokens: result.usage.cache_read_input_tokens, cacheCreateTokens: result.usage.cache_creation_input_tokens,
      reportedCostUsd: result.total_cost_usd, coverage: { reported: 1, partial: 0, missing: 0, unsupported: 0 },
    });

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

    fs.rmSync(dir, { recursive: true, force: true });
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
  // Issue #18: node-pty flushes output after shutdown closes the DB; the
  // activity update must degrade to a dropped write, not an uncaught throw.
  it('updateRunFromTerminalActivity is a no-op after the DB handle closes', () => {
    const service = new AgentService(db, sessionService, broadcaster);
    db.close();
    expect(() => service.updateRunFromTerminalActivity('term-1', 'busy')).not.toThrow();
    expect(service.updateRunFromTerminalActivity('term-1', 'busy')).toBeNull();
  });
  it('flushes a buffered runner footer into the lifecycle ledger before completion notifications', () => {
    const service = new AgentService(db, sessionService, broadcaster);
    const lifecycle = new StatusService(db,broadcaster);
    service.setLifecycleService(lifecycle);
    const completed: number[] = [];
    lifecycle.onHarnessCommitted(event => {
      if (event.type === 'turn.completed') completed.push(summary(db,{}).outputTokens);
    });
    const schedule = service.createSchedule({
      projectId: 'proj-1', name: 'Claude Run', provider: 'claude-code', workingDir: '/srv/tenex',
      prompt: 'go', scheduleKind: 'one-shot', runAt: null, recurrenceRule: null,
      timezone: 'UTC', enabled: true, nextRunAt: null, defaultTerminalLabel: 'Claude Run',
    });
    service.runNow(schedule.id);
    service.onRunnerData('term-1',claudeFixture.trimEnd()); // final JSON line is still buffered
    expect(completed).toEqual([]);
    service.handleTerminalExit('term-1',0);
    expect(completed).toEqual([877]);
    expect(service.ownsTerminalStream('term-1')).toBe(false);
    expect(terminalsDb.getById(db,'term-1')!.status).toBe('waiting');
  });

});
