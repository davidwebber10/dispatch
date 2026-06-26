import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { StatusService } from '../../src/status/service.js';

let db: Database.Database;
let broadcaster: { broadcast: ReturnType<typeof vi.fn> };

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 'proj', provider: 'claude-code', name: 'p', workingDir: '/x' });
  terminalsDb.create(db, { id: 'term', sessionId: 'proj', type: 'claude-code', label: 't', skipPermissions: true });
  broadcaster = { broadcast: vi.fn() };
});

const statusEvents = () => broadcaster.broadcast.mock.calls.map((c) => c[0]).filter((e: any) => e.type === 'terminal:status');

describe('StatusService', () => {
  it('captures session_id from the first claude event (fixes unlinked threads)', () => {
    new StatusService(db, broadcaster).ingest('claude', 'term', { hook_event_name: 'SessionStart', session_id: 'sid-1' });
    expect(terminalsDb.getById(db, 'term')?.external_id).toBe('sid-1');
  });

  it('does not clobber an existing external_id', () => {
    terminalsDb.create(db, { id: 't2', sessionId: 'proj', type: 'claude-code', label: 't2', skipPermissions: true, externalId: 'orig' });
    new StatusService(db, broadcaster).ingest('claude', 't2', { hook_event_name: 'SessionStart', session_id: 'new' });
    expect(terminalsDb.getById(db, 't2')?.external_id).toBe('orig');
  });

  it('maps events to terminal status + broadcasts rich threadStatus + activity', () => {
    const s = new StatusService(db, broadcaster);
    s.ingest('claude', 'term', { hook_event_name: 'PreToolUse', session_id: 'sid-1', tool_name: 'Bash', tool_input: { command: 'npm test' } });
    expect(terminalsDb.getById(db, 'term')?.status).toBe('working');
    expect(statusEvents().at(-1)).toMatchObject({ terminalId: 'term', status: 'working', threadStatus: 'working', activity: 'Running: npm test' });

    s.ingest('claude', 'term', { hook_event_name: 'Notification', session_id: 'sid-1', notification_type: 'permission_prompt' });
    expect(terminalsDb.getById(db, 'term')?.status).toBe('needs_input');
    expect(statusEvents().at(-1)).toMatchObject({ threadStatus: 'needs_input', activity: 'Waiting for approval' });

    s.ingest('claude', 'term', { hook_event_name: 'Stop', session_id: 'sid-1' });
    expect(terminalsDb.getById(db, 'term')?.status).toBe('waiting');
  });

  it('codex turn-complete -> idle (waiting) + captures thread-id', () => {
    terminalsDb.create(db, { id: 'cx', sessionId: 'proj', type: 'codex', label: 'c', skipPermissions: true });
    new StatusService(db, broadcaster).ingest('codex', 'cx', { type: 'agent-turn-complete', 'thread-id': 'th-7' });
    expect(terminalsDb.getById(db, 'cx')?.external_id).toBe('th-7');
    expect(terminalsDb.getById(db, 'cx')?.status).toBe('waiting');
  });

  it('markWorking sets working', () => {
    const s = new StatusService(db, broadcaster);
    s.ingest('claude', 'term', { hook_event_name: 'Stop', session_id: 'sid-1' });
    s.markWorking('term', 'Thinking…');
    expect(terminalsDb.getById(db, 'term')?.status).toBe('working');
  });

  it('ignores events for unknown terminals', () => {
    expect(() => new StatusService(db, broadcaster).ingest('claude', 'nope', { hook_event_name: 'Stop', session_id: 'x' })).not.toThrow();
  });
});

describe('StatusService thread-settled hook', () => {
  function setup() {
    const db2 = new Database(':memory:');
    initSchema(db2);
    sessionsDb.create(db2, { id: 's1', provider: 'claude-code', name: 'P', workingDir: '/tmp' });
    terminalsDb.create(db2, { id: 't1', sessionId: 's1', type: 'claude-code', label: 'CC' });
    const broadcaster2 = { broadcast: () => {} } as any;
    const fired: any[] = [];
    const svc = new StatusService(db2, broadcaster2);
    svc.setThreadSettledHook((info) => fired.push(info));
    return { db: db2, svc, fired };
  }

  it('fires when a thread goes working → idle', () => {
    const { svc, fired } = setup();
    svc.markWorking('t1');                  // → working
    svc.ingest('claude-code', 't1', { hook_event_name: 'Stop' }); // → idle (waiting)
    expect(fired.length).toBe(1);
    expect(fired[0]).toMatchObject({ terminalId: 't1', sessionId: 's1', threadStatus: 'idle' });
  });

  it('fires on working → needs_input', () => {
    const { svc, fired } = setup();
    svc.markWorking('t1');
    svc.ingest('claude-code', 't1', { hook_event_name: 'Notification', message: 'permission needed' });
    expect(fired.some((f) => f.threadStatus === 'needs_input')).toBe(true);
  });

  it('does NOT fire when already idle (no working→ transition)', () => {
    const { svc, fired } = setup();
    svc.ingest('claude-code', 't1', { hook_event_name: 'Stop' }); // starts non-working → idle
    expect(fired.length).toBe(0);
  });
});
