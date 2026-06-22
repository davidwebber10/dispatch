import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { mapHookEventToStatus, ptyStatusTick } from '../../src/sessions/status.js';
import type { PTYManager } from '../../src/pty/manager.js';

describe('mapHookEventToStatus', () => {
  it('maps UserPromptSubmit to working', () => {
    expect(mapHookEventToStatus('UserPromptSubmit')).toBe('working');
  });
  it('maps Stop to waiting', () => {
    expect(mapHookEventToStatus('Stop')).toBe('waiting');
  });
  it('maps Notification to needs_input', () => {
    expect(mapHookEventToStatus('Notification')).toBe('needs_input');
  });
  it('returns null for unknown events', () => {
    expect(mapHookEventToStatus('Unknown')).toBeNull();
  });
});

function fakePty(activity: Record<string, Date | null>): PTYManager {
  return {
    liveIds: () => Object.keys(activity),
    getLastActivity: (id: string) => activity[id] ?? null,
  } as unknown as PTYManager;
}

function setup() {
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 't', workingDir: '/tmp' });
  const events: any[] = [];
  const broadcaster = { broadcast: (e: any) => events.push(e) } as any;
  return { db, events, broadcaster };
}

describe('ptyStatusTick', () => {
  // Codex is the pty-timing provider; Claude Code is hook-driven (skipped here).
  it('marks a recently-active terminal working and rolls it up to the session', () => {
    const { db, events, broadcaster } = setup();
    terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'codex', label: 'CX' });

    ptyStatusTick(db, fakePty({ t1: new Date() }), broadcaster);

    expect(terminalsDb.getById(db, 't1')!.status).toBe('working');
    expect(sessionsDb.getById(db, 's1')!.status).toBe('working');
    expect(events).toContainEqual({ type: 'terminal:status', terminalId: 't1', status: 'working' });
    expect(events).toContainEqual({ type: 'session:status', sessionId: 's1', status: 'working' });
  });

  it('marks a terminal waiting once its PTY goes quiet', () => {
    const { db, broadcaster } = setup();
    terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'codex', label: 'CX' });
    terminalsDb.updateStatus(db, 't1', 'working');

    ptyStatusTick(db, fakePty({ t1: new Date(Date.now() - 60_000) }), broadcaster);

    expect(terminalsDb.getById(db, 't1')!.status).toBe('waiting');
  });

  it('keeps needs_input sticky while the PTY stays quiet', () => {
    const { db, broadcaster } = setup();
    terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'codex', label: 'CX' });
    terminalsDb.updateStatus(db, 't1', 'needs_input');

    ptyStatusTick(db, fakePty({ t1: new Date(Date.now() - 60_000) }), broadcaster);

    expect(terminalsDb.getById(db, 't1')!.status).toBe('needs_input');
  });

  it('leaves hook-driven (Claude Code) terminals to the StatusService', () => {
    const { db, broadcaster } = setup();
    terminalsDb.create(db, { id: 'cc1', sessionId: 's1', type: 'claude-code', label: 'CC' });
    terminalsDb.updateStatus(db, 'cc1', 'waiting');

    // Recent activity would mark a pty-timing terminal working; a hook terminal
    // must be left untouched (hooks own its status).
    ptyStatusTick(db, fakePty({ cc1: new Date() }), broadcaster);

    expect(terminalsDb.getById(db, 'cc1')!.status).toBe('waiting');
  });

  it('ignores agent-run "runner" terminals', () => {
    const { db, broadcaster } = setup();
    terminalsDb.create(db, { id: 'r1', sessionId: 's1', type: 'codex', label: 'run', config: { runner: true } });

    ptyStatusTick(db, fakePty({ r1: new Date() }), broadcaster);

    expect(terminalsDb.getById(db, 'r1')!.status).not.toBe('working');
  });
});
