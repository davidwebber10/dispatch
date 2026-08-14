import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { StatusService } from '../../src/status/service.js';

// Ghost heal: the live process's self-reported session id is authoritative when the STORED
// id has no transcript anywhere (a captured id from a boot that never ran a turn — the
// Dispatch coordinator was locked onto such a ghost and Control Plane served 0 items
// forever). A stored id whose transcript EXISTS is still never overwritten.
vi.mock('../../src/sessions/transcript-path.js', () => ({
  resolveTranscriptPath: vi.fn((workDir: string, sessionId: string) =>
    sessionId.startsWith('ghost') ? undefined : `/fake/${sessionId}.jsonl`),
}));

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

  it('does not clobber an existing external_id whose transcript exists', () => {
    terminalsDb.create(db, { id: 't2', sessionId: 'proj', type: 'claude-code', label: 't2', skipPermissions: true, externalId: 'orig' });
    new StatusService(db, broadcaster).ingest('claude', 't2', { hook_event_name: 'SessionStart', session_id: 'new' });
    expect(terminalsDb.getById(db, 't2')?.external_id).toBe('orig');
  });

  it('HEALS a ghost external_id (stored id has no transcript anywhere)', () => {
    terminalsDb.create(db, { id: 't3', sessionId: 'proj', type: 'claude-code', label: 't3', skipPermissions: true, externalId: 'ghost-1' });
    new StatusService(db, broadcaster).ingest('claude', 't3', { hook_event_name: 'SessionStart', session_id: 'real-1' });
    expect(terminalsDb.getById(db, 't3')?.external_id).toBe('real-1');
  });

  it('a ghost stored id is left alone when the reported id is the SAME id (no pointless write)', () => {
    terminalsDb.create(db, { id: 't4', sessionId: 'proj', type: 'claude-code', label: 't4', skipPermissions: true, externalId: 'ghost-2' });
    new StatusService(db, broadcaster).ingest('claude', 't4', { hook_event_name: 'SessionStart', session_id: 'ghost-2' });
    expect(terminalsDb.getById(db, 't4')?.external_id).toBe('ghost-2');
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

  it('markScheduled persists status="scheduled" (free-form, not "waiting"/"idle") and broadcasts it', () => {
    const s = new StatusService(db, broadcaster);
    s.markWorking('term');
    s.markScheduled('term', 'Scheduled — watching CI run');
    expect(terminalsDb.getById(db, 'term')?.status).toBe('scheduled');
    expect(statusEvents().at(-1)).toMatchObject({ terminalId: 'term', status: 'scheduled', threadStatus: 'scheduled', activity: 'Scheduled — watching CI run' });
  });

  it('markScheduled stamps config.scheduledWake (best effort, for a future "resumes when…" tooltip) without clobbering existing config', () => {
    terminalsDb.updateConfig(db, 'term', { transport: 'structured', agentType: 'implementer' });
    new StatusService(db, broadcaster).markScheduled('term', 'Scheduled — watching CI run');
    const config = terminalsDb.getById(db, 'term')?.config;
    expect(JSON.parse(config || '{}')).toMatchObject({ transport: 'structured', agentType: 'implementer', scheduledWake: 'Scheduled — watching CI run' });
  });
});

// Task 8: a PTY/CLI thread has no live structured session, so report_status's declaration
// (SessionService.reportStatus's fallback) is persisted onto terminal.config.pendingDeclaration
// instead of an in-memory session. The `Stop` hook is that thread's only turn boundary — it
// runs in a separate request from wherever the declaration was written, so THIS is where it
// must be consulted and cleared, mirroring how the structured path reads+clears
// `session.declared` at its `result` boundary (see structured/manager.ts).
describe('StatusService Stop-hook pendingDeclaration fallback (PTY report_status)', () => {
  const stop = { hook_event_name: 'Stop', session_id: 'sid-1' };

  it("a Stop with pendingDeclaration.state==='needs_you' settles to needs_input, not waiting", () => {
    terminalsDb.updateConfig(db, 'term', { pendingDeclaration: { state: 'needs_you', summary: 'blocked', ask: 'pick one' } });
    new StatusService(db, broadcaster).ingest('claude', 'term', stop);
    expect(terminalsDb.getById(db, 'term')?.status).toBe('needs_input');
  });

  it("a Stop with pendingDeclaration.state==='done' settles to waiting", () => {
    terminalsDb.updateConfig(db, 'term', { pendingDeclaration: { state: 'done', summary: 'shipped it' } });
    new StatusService(db, broadcaster).ingest('claude', 'term', stop);
    expect(terminalsDb.getById(db, 'term')?.status).toBe('waiting');
  });

  it("a Stop with pendingDeclaration.state==='blocked' falls through to waiting — parity with the structured path", () => {
    terminalsDb.updateConfig(db, 'term', { pendingDeclaration: { state: 'blocked', summary: 'waiting on another agent', blocker: 'agent X' } });
    new StatusService(db, broadcaster).ingest('claude', 'term', stop);
    expect(terminalsDb.getById(db, 'term')?.status).toBe('waiting');
  });

  it('a Stop with no pendingDeclaration behaves exactly as before (waiting) — no regression', () => {
    new StatusService(db, broadcaster).ingest('claude', 'term', stop);
    expect(terminalsDb.getById(db, 'term')?.status).toBe('waiting');
  });

  it('the declaration is CLEARED after the Stop: a second Stop with no new declaration settles to waiting (does not leak into the next turn)', () => {
    terminalsDb.updateConfig(db, 'term', { pendingDeclaration: { state: 'needs_you', summary: 'blocked', ask: 'pick one' } });
    const s = new StatusService(db, broadcaster);

    s.ingest('claude', 'term', stop);
    expect(terminalsDb.getById(db, 'term')?.status).toBe('needs_input');

    s.ingest('claude', 'term', stop); // turn N+1: nothing new declared
    expect(terminalsDb.getById(db, 'term')?.status).toBe('waiting');
  });

  it('persists config.lastOutcome the same shape the structured path writes (declared ⇒ inferred:false)', () => {
    terminalsDb.updateConfig(db, 'term', { pendingDeclaration: { state: 'done', summary: 'shipped the thing' } });
    new StatusService(db, broadcaster).ingest('claude', 'term', stop);
    const cfg = JSON.parse(terminalsDb.getById(db, 'term')?.config || '{}');
    expect(cfg.pendingDeclaration).toBeUndefined();
    expect(cfg.lastOutcome).toMatchObject({ summary: 'shipped the thing', needsHelp: false, inferred: false });
    expect(typeof cfg.lastOutcome.at).toBe('string');
  });

  it('lastOutcome.needsHelp is true for a needs_you declaration', () => {
    terminalsDb.updateConfig(db, 'term', { pendingDeclaration: { state: 'needs_you', summary: 'need input', ask: 'which?' } });
    new StatusService(db, broadcaster).ingest('claude', 'term', stop);
    const cfg = JSON.parse(terminalsDb.getById(db, 'term')?.config || '{}');
    expect(cfg.lastOutcome).toMatchObject({ needsHelp: true, inferred: false });
  });

  // Parity with SessionService.noteTurnOutcome (structured path): a declared blocked/done PTY
  // turn must persist the same `declaredState`/`blocker` keys, with the same semantics, so a
  // board reading `declaredState` off `lastOutcome` doesn't have to care which transport wrote
  // the row.
  it("a declared 'blocked' outcome persists declaredState:'blocked' and the blocker text", () => {
    terminalsDb.updateConfig(db, 'term', { pendingDeclaration: { state: 'blocked', summary: 'waiting on another agent', blocker: 'agent X' } });
    new StatusService(db, broadcaster).ingest('claude', 'term', stop);
    const cfg = JSON.parse(terminalsDb.getById(db, 'term')?.config || '{}');
    expect(cfg.lastOutcome).toMatchObject({ declaredState: 'blocked', blocker: 'agent X', inferred: false });
  });

  it("a declared 'done' outcome persists declaredState:'done' and no blocker key", () => {
    terminalsDb.updateConfig(db, 'term', { pendingDeclaration: { state: 'done', summary: 'shipped it' } });
    new StatusService(db, broadcaster).ingest('claude', 'term', stop);
    const cfg = JSON.parse(terminalsDb.getById(db, 'term')?.config || '{}');
    expect(cfg.lastOutcome).toMatchObject({ declaredState: 'done', inferred: false });
    expect(cfg.lastOutcome.blocker).toBeUndefined();
  });

  it("a declared 'needs_you' outcome persists NO declaredState (still settles needs_input, unchanged)", () => {
    terminalsDb.updateConfig(db, 'term', { pendingDeclaration: { state: 'needs_you', summary: 'need input', ask: 'which?' } });
    new StatusService(db, broadcaster).ingest('claude', 'term', stop);
    expect(terminalsDb.getById(db, 'term')?.status).toBe('needs_input');
    const cfg = JSON.parse(terminalsDb.getById(db, 'term')?.config || '{}');
    expect(cfg.lastOutcome.declaredState).toBeUndefined();
  });

  it('a Stop with no pendingDeclaration at all persists no declaredState (undeclared/inferred outcome unaffected)', () => {
    new StatusService(db, broadcaster).ingest('claude', 'term', stop);
    expect(terminalsDb.getById(db, 'term')?.status).toBe('waiting');
    // No pendingDeclaration means consumePendingDeclaration returns null and lastOutcome is
    // never written from this path at all — nothing here regresses the pre-existing behaviour.
    const cfg = JSON.parse(terminalsDb.getById(db, 'term')?.config || '{}');
    expect(cfg.lastOutcome).toBeUndefined();
  });

  it("an empty or whitespace-only blocker string omits the key rather than persisting ''", () => {
    terminalsDb.updateConfig(db, 'term', { pendingDeclaration: { state: 'blocked', summary: 'waiting', blocker: '   ' } });
    new StatusService(db, broadcaster).ingest('claude', 'term', stop);
    const cfg = JSON.parse(terminalsDb.getById(db, 'term')?.config || '{}');
    expect(cfg.lastOutcome.declaredState).toBe('blocked');
    expect(cfg.lastOutcome.blocker).toBeUndefined();
    expect('blocker' in cfg.lastOutcome).toBe(false);
  });

  it('does not consult pendingDeclaration on a non-Stop event', () => {
    terminalsDb.updateConfig(db, 'term', { pendingDeclaration: { state: 'needs_you', summary: 'x' } });
    new StatusService(db, broadcaster).ingest('claude', 'term', { hook_event_name: 'PreToolUse', session_id: 'sid-1', tool_name: 'Bash' });
    expect(terminalsDb.getById(db, 'term')?.status).toBe('working');
    const cfg = JSON.parse(terminalsDb.getById(db, 'term')?.config || '{}');
    expect(cfg.pendingDeclaration).toEqual({ state: 'needs_you', summary: 'x' }); // untouched, still pending for the eventual Stop
  });
});

describe('StatusService activity stamping', () => {
  const OLD = '2020-01-01T00:00:00.000Z';
  const seedOldActivity = () => {
    db.prepare('UPDATE sessions SET last_activity_at = ?').run(OLD);
    db.prepare('UPDATE terminals SET last_activity_at = ?').run(OLD);
  };
  const sessionActivity = () => (db.prepare("SELECT last_activity_at FROM sessions WHERE id = 'proj'").get() as any).last_activity_at;
  const terminalActivity = () => (db.prepare("SELECT last_activity_at FROM terminals WHERE id = 'term'").get() as any).last_activity_at;

  it('SessionStart (open/revive) does NOT stamp activity', () => {
    seedOldActivity();
    new StatusService(db, broadcaster).ingest('claude', 'term', { hook_event_name: 'SessionStart', session_id: 'sid-1' });
    expect(sessionActivity()).toBe(OLD);
    expect(terminalActivity()).toBe(OLD);
  });

  it('UserPromptSubmit (turn start) stamps activity on session and terminal', () => {
    seedOldActivity();
    new StatusService(db, broadcaster).ingest('claude', 'term', { hook_event_name: 'UserPromptSubmit', session_id: 'sid-1' });
    expect(sessionActivity()).not.toBe(OLD);
    expect(terminalActivity()).not.toBe(OLD);
  });

  it('Stop (turn completed) stamps activity', () => {
    seedOldActivity();
    new StatusService(db, broadcaster).ingest('claude', 'term', { hook_event_name: 'Stop', session_id: 'sid-1' });
    expect(sessionActivity()).not.toBe(OLD);
    expect(terminalActivity()).not.toBe(OLD);
  });

  it('markNeedsInput stamps activity', () => {
    seedOldActivity();
    new StatusService(db, broadcaster).markNeedsInput('term', 'Needs approval: Bash');
    expect(sessionActivity()).not.toBe(OLD);
  });
});

describe('StatusService onActivity callback (feeds ThreadAutoNamer)', () => {
  it('UserPromptSubmit (turn start) fires the onActivity callback', () => {
    const onActivity = vi.fn();
    new StatusService(db, broadcaster, onActivity).ingest('claude', 'term', { hook_event_name: 'UserPromptSubmit', session_id: 'sid-1' });
    expect(onActivity).toHaveBeenCalledWith('term');
  });

  it('SessionStart (open/revive) does NOT fire the onActivity callback', () => {
    const onActivity = vi.fn();
    new StatusService(db, broadcaster, onActivity).ingest('claude', 'term', { hook_event_name: 'SessionStart', session_id: 'sid-1' });
    expect(onActivity).not.toHaveBeenCalled();
  });
});

describe('StatusService onWatchStatus callback (feeds WatchDispatcher)', () => {
  it('a status edge fires the onWatchStatus callback with the terminal id and normalized status', () => {
    const onWatchStatus = vi.fn();
    new StatusService(db, broadcaster, undefined, onWatchStatus).ingest('claude', 'term', { hook_event_name: 'Stop', session_id: 'sid-1' });
    expect(onWatchStatus).toHaveBeenCalledWith('term', 'idle');
  });

  it('SessionStart (open/revive) does NOT fire the onWatchStatus callback', () => {
    const onWatchStatus = vi.fn();
    new StatusService(db, broadcaster, undefined, onWatchStatus).ingest('claude', 'term', { hook_event_name: 'SessionStart', session_id: 'sid-1' });
    expect(onWatchStatus).not.toHaveBeenCalled();
  });

  it('a throwing onWatchStatus callback does not break status recording', () => {
    const onWatchStatus = vi.fn(() => { throw new Error('boom'); });
    const s = new StatusService(db, broadcaster, undefined, onWatchStatus);
    expect(() => s.ingest('claude', 'term', { hook_event_name: 'Stop', session_id: 'sid-1' })).not.toThrow();
    expect(terminalsDb.getById(db, 'term')?.status).toBe('waiting');
  });
});

describe('StatusService manual-override clearing (board state)', () => {
  it('clears a manual override when the thread shows real activity', () => {
    terminalsDb.updateConfig(db, 'term', { boardState: { override: 'complete' } });
    const s = new StatusService(db, broadcaster);
    s.markWorking('term');
    const cfg = JSON.parse(terminalsDb.getById(db, 'term')?.config || '{}');
    expect(cfg.boardState?.override ?? null).toBeNull();
  });

  it('clears a manual override on the needs_input edge too', () => {
    terminalsDb.updateConfig(db, 'term', { boardState: { override: 'resting' } });
    const s = new StatusService(db, broadcaster);
    s.markNeedsInput('term');
    const cfg = JSON.parse(terminalsDb.getById(db, 'term')?.config || '{}');
    expect(cfg.boardState?.override ?? null).toBeNull();
  });

  // Finding 1 (Critical): the old condition only cleared the override on working/needs_input
  // (resume/escalate) and missed the settle edge (markIdle) — a thread that finished a turn
  // normally kept a stale override forever, frozen on the board despite a fresh lastOutcome.
  // `apply()` clears on every call now; this proves the settle edge specifically.
  it('clears a manual override on the settle edge too (markIdle) — a thread that finishes normally must not stay frozen', () => {
    terminalsDb.updateConfig(db, 'term', { boardState: { override: 'complete' } });
    const s = new StatusService(db, broadcaster);
    s.markIdle('term');
    const cfg = JSON.parse(terminalsDb.getById(db, 'term')?.config || '{}');
    expect(cfg.boardState?.override ?? null).toBeNull();
  });

  it('preserves acknowledgedAt while clearing the override', () => {
    terminalsDb.updateConfig(db, 'term', { boardState: { acknowledgedAt: '2020-01-01T00:00:00.000Z', override: 'needs_help' } });
    const s = new StatusService(db, broadcaster);
    s.markWorking('term');
    const cfg = JSON.parse(terminalsDb.getById(db, 'term')?.config || '{}');
    expect(cfg.boardState).toMatchObject({ acknowledgedAt: '2020-01-01T00:00:00.000Z', override: null });
  });

  it('is a no-op when there is no override set', () => {
    const s = new StatusService(db, broadcaster);
    s.markWorking('term');
    const cfg = JSON.parse(terminalsDb.getById(db, 'term')?.config || '{}');
    expect(cfg.boardState).toBeUndefined();
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
    svc.addThreadSettledListener((info) => fired.push(info));
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

  it('does NOT fire on working → scheduled — a dormant agent has not finished, so no completion/push notice', () => {
    const { svc, fired } = setup();
    svc.markWorking('t1');
    svc.markScheduled('t1', 'Scheduled — watching CI run');
    expect(fired.length).toBe(0);
  });
});
