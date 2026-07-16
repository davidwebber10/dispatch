import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/connection.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { StatusService } from '../status/service.js';
import { wireThreadSettledPush } from './notify.js';

const fakeBroadcaster = { broadcast: () => {} } as any;

let dir: string;
let db: Database.Database;
let statusService: StatusService;
let notifyThread: ReturnType<typeof vi.fn>;

function seedThread(id: string, config: Record<string, any>) {
  terminalsDb.create(db, { id, sessionId: 's1', type: 'claude-code', label: `Claude Code ${id}`, config });
  terminalsDb.updateStatus(db, id, 'working'); // settled hook fires only on working → settled edges
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-notify-'));
  db = createDatabase(path.join(dir, 'test.db'));
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'proj', workingDir: '/tmp/proj' });
  statusService = new StatusService(db, fakeBroadcaster);
  notifyThread = vi.fn().mockResolvedValue(undefined);
  wireThreadSettledPush(db, statusService, { notifyThread } as any);
});
afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('wireThreadSettledPush — per-thread gate + template copy', () => {
  it('does NOT push for a thread without alertsEnabled', () => {
    seedThread('t1', {});
    statusService.markIdle('t1');
    expect(notifyThread).not.toHaveBeenCalled();
  });

  it('pushes "Completed its task" when a bell-enabled thread goes idle', () => {
    seedThread('t2', { alertsEnabled: true });
    statusService.markIdle('t2');
    expect(notifyThread).toHaveBeenCalledWith({
      terminalId: 't2', sessionId: 's1', title: 'Claude Code t2', body: 'Completed its task',
    });
  });

  it('pushes "Is asking a question" on needs_input', () => {
    seedThread('t3', { alertsEnabled: true });
    statusService.markNeedsInput('t3');
    expect(notifyThread).toHaveBeenCalledWith({
      terminalId: 't3', sessionId: 's1', title: 'Claude Code t3', body: 'Is asking a question',
    });
  });

  it('fires only on the working → settled edge (no repeat when already idle)', () => {
    seedThread('t4', { alertsEnabled: true });
    statusService.markIdle('t4');
    statusService.markIdle('t4'); // prior status is now 'waiting' — no edge
    expect(notifyThread).toHaveBeenCalledTimes(1);
  });

  it('treats a malformed config blob as alerts-off', () => {
    seedThread('t5', {});
    db.prepare('UPDATE terminals SET config = ? WHERE id = ?').run('{not json', 't5');
    statusService.markIdle('t5');
    expect(notifyThread).not.toHaveBeenCalled();
  });
});
