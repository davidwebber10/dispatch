// Regression (engineering review, reliability #5): a one-shot watch must not be spent, and a
// repeating watch must not wake its watcher twice, when the target reports the same status again.
// Real StatusService + real WatchDispatcher on one database.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../src/db/schema.js';
import * as sessionsDb from '../src/db/sessions.js';
import * as terminalsDb from '../src/db/terminals.js';
import * as watchesDb from '../src/db/watches.js';
import { StatusService } from '../src/status/service.js';
import { WatchDispatcher } from '../src/sessions/watch-dispatcher.js';

let db: Database.Database;
let delivered: { to: string; text: string }[];
let status: StatusService;

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 'proj', provider: 'claude-code', name: 'p', workingDir: '/x' });
  terminalsDb.create(db, { id: 'target', sessionId: 'proj', type: 'claude-code', label: 'Worker', skipPermissions: true });
  terminalsDb.create(db, { id: 'watcher', sessionId: 'proj', type: 'claude-code', label: 'Lead', skipPermissions: true });
  delivered = [];
  const dispatcher = new WatchDispatcher(db, (to, text) => { delivered.push({ to, text }); });
  status = new StatusService(db, { broadcast: vi.fn() }, undefined, (id, s) => dispatcher.onStatus(id, s));
});

describe('repeated watch wakes', () => {
  it('a repeating watch wakes its watcher once for one settle, though idle is reported three times', () => {
    watchesDb.create(db, { watcherTerminalId: 'watcher', targetTerminalId: 'target', criteria: 'idle', once: false, note: null });
    status.markWorking('target');
    status.markIdle('target');
    status.markIdle('target');
    status.ingest('claude', 'target', { hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    expect(delivered).toHaveLength(1);
    expect(delivered[0].to).toBe('watcher');
  });

  it('a repeating watch wakes again on the next turn', () => {
    watchesDb.create(db, { watcherTerminalId: 'watcher', targetTerminalId: 'target', criteria: 'idle', once: false, note: null });
    status.markWorking('target');
    status.markIdle('target');
    status.markIdle('target');
    status.markWorking('target');
    status.markIdle('target');
    expect(delivered).toHaveLength(2);
  });

  it('a one-shot watch made after a settle is not spent by a second idle report of that settle', () => {
    status.markWorking('target');
    status.markIdle('target');
    // The watcher asks to be told about the NEXT settle.
    const w2 = watchesDb.create(db, { watcherTerminalId: 'watcher', targetTerminalId: 'target', criteria: 'idle', once: true, note: null });
    status.markIdle('target'); // the late second idle of the OLD turn
    expect(delivered).toHaveLength(0);
    expect(watchesDb.getById(db, w2)?.fired_at ?? null).toBeNull();
    status.markWorking('target');
    status.markIdle('target');
    expect(delivered).toHaveLength(1);
    expect(watchesDb.getById(db, w2)?.fired_at).toBeTruthy();
  });
});
