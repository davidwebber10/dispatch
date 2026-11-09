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
