// Regression (engineering review, reliability #3): a daemon restart during a scheduled run left
// the run row open, and listDueSchedules then skipped that schedule for ever. Two "daemons" (two
// AgentService instances) on ONE database file, as a real restart is.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as agentsDb from '../../src/db/agents.js';
import { AgentService } from '../../src/agents/service.js';
import { EventEmitter } from 'events';
import { StatusService } from '../../src/status/service.js';
import { SessionService } from '../../src/sessions/service.js';
import { reconcileAtBoot, wireRestoredQuestions } from '../../src/sessions/boot-reconcile.js';
import type { IStructuredManager } from '../../src/structured/manager.js';

let dir: string;
let dbPath: string;

/** One daemon life: its own database handle and its own set of live processes. */
function boot() {
  const db = new Database(dbPath);
  initSchema(db);
  const live = new Set<string>();
  let n = 0;
  const sessionService: any = {
    createRunnerTerminal: vi.fn((sessionId: string, type: string, label: string, workingDir: string, prompt: string) => {
      const id = `term-${Date.now()}-${++n}`;
      terminalsDb.create(db, { id, sessionId, type: type as any, label, skipPermissions: true, workingDir, config: { runner: true, runnerPrompt: prompt } });
      live.add(id);
      return terminalsDb.rowToTerminal(terminalsDb.getById(db, id)!);
    }),
    stopTerminal: vi.fn(),
  };
  const broadcaster = { broadcast: vi.fn() };
  return { db, live, service: new AgentService(db, sessionService, broadcaster), broadcaster, isAlive: (id: string) => live.has(id) };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-recovery-'));
  dbPath = path.join(dir, 'dispatch.db');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('restart recovery: runs', () => {
  it('a daily schedule that was due three times while the daemon was down runs ONCE on start (hosted continuity, item e)', () => {
    const d = boot();
    sessionsDb.create(d.db, { id: 'proj-1', provider: 'codex', name: 'tenex', workingDir: '/srv/tenex' });
    const schedule = d.service.createSchedule({
      projectId: 'proj-1', name: 'Daily', provider: 'codex', workingDir: '/srv/tenex', prompt: 'Report',
      scheduleKind: 'recurring', runAt: null, recurrenceRule: JSON.stringify({ type: 'daily', time: '12:00' }), timezone: 'UTC',
      enabled: true, nextRunAt: null, defaultTerminalLabel: 'Daily',
    });
    agentsDb.updateSchedule(d.db, schedule.id, { enabled: true, nextRunAt: '2026-05-08T12:00:00.000Z' });
    const now = '2026-05-11T09:00:00.000Z'; // down for three noons
    expect(d.service.processDueRuns(now)).toHaveLength(1);
    const next = d.db.prepare('SELECT next_run_at FROM agent_schedules WHERE id = ?').get(schedule.id) as { next_run_at: string };
    expect(Date.parse(next.next_run_at)).toBeGreaterThan(Date.parse(now));
    expect(d.service.processDueRuns(now)).toHaveLength(0);
    d.db.close();
  });

  it('an open run with a dead terminal is closed at boot and the schedule fires again', () => {
    // Daemon 1: a recurring schedule fires and its run is at work.
    const first = boot();
    sessionsDb.create(first.db, { id: 'proj-1', provider: 'codex', name: 'tenex', workingDir: '/srv/tenex' });
    const schedule = first.service.createSchedule({
      projectId: 'proj-1', name: 'Nightly', provider: 'codex', workingDir: '/srv/tenex', prompt: 'Fix CI',
      scheduleKind: 'recurring', runAt: null, recurrenceRule: 'FREQ=DAILY;BYHOUR=12;BYMINUTE=0', timezone: 'UTC',
      enabled: true, nextRunAt: null, defaultTerminalLabel: 'Nightly',
    });
    agentsDb.updateSchedule(first.db, schedule.id, { enabled: true, nextRunAt: '2026-05-08T12:00:00.000Z' });
    const [run] = first.service.processDueRuns('2026-05-08T12:01:00.000Z');
    expect(run.status).toBe('working');
    // The daemon stops during the run: the process is gone, the row stays 'working'.
    first.db.close();

    // Daemon 2 on the same database. Its process table is empty.
    const second = boot();
    agentsDb.updateSchedule(second.db, schedule.id, { enabled: true, nextRunAt: '2026-05-09T12:00:00.000Z' });
    // The bug: with no boot cleanup the schedule is never due again.
    expect(agentsDb.listDueSchedules(second.db, '2026-05-09T12:01:00.000Z')).toEqual([]);

    const closed = second.service.reconcileRunsAtBoot(second.isAlive);

    expect(closed.map((r) => r.id)).toEqual([run.id]);
    expect(agentsDb.getRun(second.db, run.id)).toMatchObject({ status: 'failed', error: 'The daemon restarted during this run.' });
    expect(agentsDb.listDueSchedules(second.db, '2026-05-09T12:01:00.000Z').map((s) => s.id)).toEqual([schedule.id]);
    // The next tick starts a new run of the schedule.
    const fired = second.service.processDueRuns('2026-05-09T12:01:00.000Z');
    expect(fired).toHaveLength(1);
    expect(fired[0].id).not.toBe(run.id);
    expect(fired[0].status).toBe('working');
    // A boot check after that leaves the new, live run open.
    expect(second.service.reconcileRunsAtBoot(second.isAlive)).toEqual([]);
    expect(agentsDb.getRun(second.db, fired[0].id)!.status).toBe('working');
    second.db.close();
  });
});

// Regression (engineering review, top 15 #10; reliability #7, second half): a restart lost a
// thread's scheduled wake and the question a thread waited on, and said nothing (W2-C).
describe('restart recovery: wakes and questions', () => {
  /** One daemon life: real StatusService and SessionService; the manager remembers nothing of the last life. */
  function daemon() {
    const db = new Database(dbPath);
    initSchema(db);
    if (!sessionsDb.getById(db, 'proj')) {
      sessionsDb.create(db, { id: 'proj', provider: 'claude-code', name: 'p', workingDir: dir });
      terminalsDb.create(db, { id: 't', sessionId: 'proj', type: 'claude-code', label: 'Thread', skipPermissions: true, config: { transport: 'structured' } });
    }
    const live = new Set<string>();
    const pending = new Map<string, unknown>();
    const manager = Object.assign(new EventEmitter(), {
      isAlive: (id: string) => live.has(id),
      getPending: (id: string) => pending.get(id) ?? null,
    });
    const status = new StatusService(db, { broadcast: vi.fn() });
    const pty = { isAlive: () => false, on: () => {}, setDefaultEnv: () => {} };
    const sessions = new SessionService(db, pty as any, path.join(dir, 'mcp.json'));
    sessions.setStructuredManager(manager as unknown as IStructuredManager);
    wireRestoredQuestions(db, sessions, [manager as unknown as IStructuredManager], status);
    const isAlive = (id: string) => live.has(id);
    const boot = () => {
      const r = reconcileAtBoot({ db, isAlive, markIdle: (id, activity) => status.markIdle(id, activity) });
      const waiting = new Set(r.restoredQuestions);
      status.reconcileProcesses((id) => isAlive(id) || waiting.has(id));
      return r;
    };
    return { db, live, pending, manager, status, sessions, boot };
  }

  it('a scheduled thread with a dead process is flagged', () => {
    const first = daemon();
    first.boot(); // every daemon runs the boot check when it starts; a wake scheduled after it is one a restart can lose
    first.live.add('t');
    first.status.markWorking('t');
    first.status.markScheduled('t', 'Scheduled — check the deploy');
    expect(terminalsDb.getById(first.db, 't')!.status).toBe('scheduled');
    first.db.close();

    const second = daemon(); // the process, and the wake inside it, are gone
    expect(second.boot().lostWakes).toEqual(['t']);
    const events = second.db.prepare("SELECT event_type FROM lifecycle_events WHERE terminal_id = 't' AND event_type = 'wake.lost'").all();
    expect(events).toHaveLength(1); // lifecycle event wake.lost
    expect(terminalsDb.getById(second.db, 't')!.status).toBe('waiting'); // not "scheduled" for ever
    second.db.close();
  });

  it('a pending question is shown again after a new daemon on the same database', () => {
    const question = { requestId: 'req-7', toolName: 'AskUserQuestion', input: {}, questions: [{ header: 'Go', question: 'Deploy now?', options: [{ label: 'yes' }, { label: 'no' }] }] };
    const first = daemon();
    first.live.add('t');
    first.status.markWorking('t');
    first.pending.set('t', question);
    first.manager.emit('permission', 't', question); // the manager event the daemon hears when the model asks
    first.status.markNeedsInput('t', 'Needs your answer');
    expect(first.sessions.getPendingPermission('t')).toEqual(question);
    first.db.close();

    const second = daemon();
    expect(second.manager.getPending('t')).toBeNull(); // the new manager knows nothing
    expect(second.boot().restoredQuestions).toEqual(['t']);
    expect(second.sessions.getPendingPermission('t')).toEqual(question); // getPendingPermission returns the payload
    expect(terminalsDb.getById(second.db, 't')!.status).toBe('needs_input');
    second.db.close();
  });
});
