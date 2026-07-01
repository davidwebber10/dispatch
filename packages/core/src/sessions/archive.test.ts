import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/connection.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import * as agentsDb from '../db/agents.js';
import { SessionService } from './service.js';

// archive() only touches ptyManager.isAlive/kill; nothing is alive in a test DB.
const fakePty = { isAlive: () => false, kill: () => {} } as any;

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-archive-'));
  db = createDatabase(path.join(dir, 'test.db'));
});
afterEach(() => {
  try { db.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe('SessionService.archive with scheduled-agent run history', () => {
  it('archives a session whose terminal is referenced by an agent_run, preserving the run', () => {
    // A session with one terminal that a completed scheduled-agent run points at.
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'tenex', workingDir: '/tmp/tenex' });
    terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 'Claude Code' });
    agentsDb.createSchedule(db, {
      id: 'sch1', projectId: 's1', name: 'daily', provider: 'claude-code', workingDir: '/tmp/tenex',
      prompt: 'say hi', scheduleKind: 'recurring', runAt: null, recurrenceRule: 'FREQ=DAILY',
      timezone: 'UTC', enabled: true, nextRunAt: null, defaultTerminalLabel: null,
    });
    agentsDb.createRun(db, {
      id: 'run1', scheduleId: 'sch1', projectId: 's1', terminalId: 't1', provider: 'claude-code',
      promptSnapshot: 'say hi', status: 'succeeded', error: null, externalSessionId: null,
    });

    const svc = new SessionService(db, fakePty, path.join(dir, 'mcp.json'));

    // The FOREIGN KEY constraint fires here today: removeBySession() can't delete
    // a terminal that agent_runs.terminal_id still references.
    expect(() => svc.archive('s1')).not.toThrow();

    // Session soft-archived, its terminals hard-deleted...
    expect(sessionsDb.getById(db, 's1')?.archived_at).toBeTruthy();
    expect(terminalsDb.getById(db, 't1')).toBeNull();

    // ...and the run's history survives with its terminal reference cleared.
    const run = agentsDb.getRun(db, 'run1');
    expect(run).not.toBeNull();
    expect(run?.terminal_id).toBeNull();
  });
});
