// Regression (engineering review, top 15 #6, reliability table #4, cause A): the chat showed "Working" for
// ever, because the client worked out "busy" from the frames it happened to see. One class for each way the
// frames go wrong. In every one the daemon's status is right, and the structured socket now says it: the
// header of a connection and each live status frame carry `turnOpen` (W3-C, one status authority).
//
// Real database, real StatusService, the real socket handler. The manager is a stand-in that only holds a ring.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { StatusService } from '../../src/status/service.js';
import { handleStructuredConnection } from '../../src/ws/structured.js';
import type { HarnessEvent } from '../../src/runtime/events.js';

let db: Database.Database;
let status: StatusService;
let seq: number;

// A ring that ends mid-turn: the assistant is streaming and no `result` follows.
const OPEN_RING = [
  { type: 'user', message: { role: 'user', content: 'go' } },
  { type: 'stream_event', event: { type: 'message_start' } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash' } } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'sleep 600' } }] } },
];

function manager(ring: unknown[] = OPEN_RING) {
  return Object.assign(new EventEmitter(), { getEvents: () => ring, getEventsTail: (_id: string, n: number) => ring.slice(-n), getPending: () => null }) as any;
}
/** A client of the structured socket: every frame it got, and the status frames among them. */
function client(id: string, svc: StatusService = status, mgr = manager()) {
  const frames: any[] = [];
  const handlers: Record<string, () => void> = {};
  const ws = { readyState: 1, send: (s: string) => frames.push(JSON.parse(s)), close: () => {}, on: (e: string, fn: () => void) => { handlers[e] = fn; } } as any;
  handleStructuredConnection(
    ws, { url: `/api/terminals/${id}/structured-ws?tail=200` } as any, mgr, undefined, undefined, undefined,
    (tid) => terminalsDb.getById(db, tid)?.status !== 'working', undefined, undefined, svc,
  );
  const statusFrames = () => frames.filter((f) => f.type === 'system' && f.subtype === 'status' && typeof f.turnOpen === 'boolean');
  return { frames, statusFrames, last: () => statusFrames().at(-1), close: () => handlers.close?.(), mgr };
}
function event(terminalId: string, type: HarnessEvent['type'], extra: Record<string, unknown> = {}, provider = 'claude-code'): HarnessEvent {
  return { terminalId, provider, generation: 'gen-1', sequence: ++seq, eventId: `e${seq}`, observedAt: new Date().toISOString(), transport: 'structured', turnId: 'turn-1', type, ...extra } as HarnessEvent;
}
function startTurn(id: string, provider = 'claude-code') {
  expect(status.accept(event(id, 'process.started', {}, provider))).toBe(true);
  expect(status.accept(event(id, 'turn.started', {}, provider))).toBe(true);
}

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 'proj', provider: 'claude-code', name: 'p', workingDir: '/x' });
  terminalsDb.create(db, { id: 'cc', sessionId: 'proj', type: 'claude-code', label: 'cc', skipPermissions: true });
  terminalsDb.create(db, { id: 'cx', sessionId: 'proj', type: 'codex', label: 'cx', skipPermissions: true });
  status = new StatusService(db, { broadcast: vi.fn() });
  seq = 0;
});

describe('Working forever: the socket says the status, the frames do not', () => {
  it('the header is the first frame and says turnOpen while the turn runs', () => {
    startTurn('cc');
    const c = client('cc');
    expect(c.frames[0]).toMatchObject({ type: 'system', subtype: 'status', status: 'working', turnOpen: true });
    expect(c.frames[0]).toEqual({ type: 'system', subtype: 'status', ...status.snapshot('cc') });
  });

  it('stale working after exit: the process exits mid-turn and the client is told the turn is over', () => {
    startTurn('cc');
    const c = client('cc');
    expect(c.last()).toMatchObject({ turnOpen: true });
    expect(status.accept(event('cc', 'process.exited', { exitCode: 1 }))).toBe(true);
    expect(c.last()).toMatchObject({ status: 'error', turnOpen: false });
    expect(c.last().sequence).toBeGreaterThan(c.statusFrames()[0].sequence);
  });

  it('reconnect mid-turn: the new connection gets the truth both while the turn runs and after it', () => {
    startTurn('cc');
    const first = client('cc');
    first.close();
    // The turn ends while no socket is open: the first client never sees a result.
    const second = client('cc');
    expect(second.frames[0]).toMatchObject({ turnOpen: true }); // still running: Working is right
    second.close();
    expect(status.accept(event('cc', 'turn.completed', { outcome: 'idle', detail: {} }))).toBe(true);
    expect(first.statusFrames()).toHaveLength(1); // a closed socket gets nothing more
    const third = client('cc');
    // The ring still ends mid-turn (OPEN_RING has no result), and the header says the turn is closed.
    expect(third.frames[0]).toMatchObject({ status: 'idle', turnOpen: false });
  });

  it('a missed result: the turn is closed with no result frame in the ring or on the wire', () => {
    startTurn('cc');
    const c = client('cc');
    expect(status.accept(event('cc', 'turn.completed', { outcome: 'idle', detail: {} }))).toBe(true);
    expect(c.frames.some((f) => f.type === 'result')).toBe(false); // nothing for a frame fold to settle on
    expect(c.last()).toMatchObject({ status: 'idle', turnOpen: false });
  });

  it('an interrupted turn: a failed turn and a user reset both close it for the client', () => {
    startTurn('cc');
    const c = client('cc');
    expect(status.accept(event('cc', 'turn.failed'))).toBe(true);
    expect(c.last()).toMatchObject({ status: 'error', turnOpen: false });

    status.markWorking('cc');
    expect(c.last()).toMatchObject({ turnOpen: true });
    expect(status.resetStatus('cc')).toBe(true);
    expect(c.last()).toMatchObject({ status: 'idle', turnOpen: false });
  });

  it('a question closes the spinner and the answer opens it again', () => {
    startTurn('cc');
    const c = client('cc');
    expect(status.accept(event('cc', 'permission.requested', { toolName: 'AskUserQuestion', questions: [{ question: 'Deploy?' }] }))).toBe(true);
    expect(c.last()).toMatchObject({ status: 'needs_input', turnOpen: false });
    expect(status.accept(event('cc', 'permission.resolved'))).toBe(true);
    expect(c.last()).toMatchObject({ status: 'working', turnOpen: true });
  });

  it('a restart: a new daemon settles a working thread with no process, and its header says so', () => {
    startTurn('cc');
    const before = status.snapshot('cc')!;
    // The daemon dies with no shutdown: the row stays `working`. A new daemon opens the same database.
    const next = new StatusService(db, { broadcast: vi.fn() });
    expect(next.snapshot('cc')).toMatchObject({ status: 'working', turnOpen: true });
    next.reconcileProcesses(() => false); // boot: no process backs the thread
    const c = client('cc', next);
    expect(c.frames[0]).toMatchObject({ status: 'error', turnOpen: false });
    // A client that kept the old daemon's last frame takes the new one: its generation is higher.
    expect(c.frames[0].generation).toBeGreaterThan(before.generation);
  });

  // Found in the manual check (kill -9 of the daemon mid-turn, page open): the page reconnects first and its
  // connection starts the process again. The boot check then found a live process and left `working` for ever.
  it('a restart: a thread whose process the reconnect started again, with no turn in the new daemon, is settled', () => {
    startTurn('cc');
    const next = new StatusService(db, { broadcast: vi.fn() });
    expect(next.accept({ ...event('cc', 'process.started'), generation: 'gen-2', sequence: 1, turnId: undefined })).toBe(true);
    const c = client('cc', next);
    expect(c.frames[0]).toMatchObject({ status: 'working', turnOpen: true }); // the stored status, until the boot check
    next.reconcileProcesses(() => true); // the process is alive: the reconnect started it
    expect(c.last()).toMatchObject({ status: 'error', turnOpen: false });
    expect(terminalsDb.getById(db, 'cc')!.status).toBe('error');
  });

  it('a restart: a thread that runs a turn in the new daemon keeps working through the boot check', () => {
    startTurn('cc');
    const next = new StatusService(db, { broadcast: vi.fn() });
    expect(next.accept({ ...event('cc', 'process.started'), generation: 'gen-2', sequence: 1, turnId: undefined })).toBe(true);
    expect(next.accept({ ...event('cc', 'turn.started'), generation: 'gen-2', sequence: 2, turnId: 'turn-2' })).toBe(true); // the boot kickstart
    next.reconcileProcesses(() => true);
    expect(next.snapshot('cc')).toMatchObject({ status: 'working', turnOpen: true });
  });

  it('a restart with a kept turn: the shutdown write-back reads as an open turn until the boot settles it', () => {
    startTurn('cc');
    expect(status.accept(event('cc', 'process.exited', { exitCode: 0 }))).toBe(true); // the shutdown's kill
    StatusService.restoreInterruptedTurn(db, 'cc');
    const next = new StatusService(db, { broadcast: vi.fn() });
    const c = client('cc', next);
    expect(c.frames[0]).toMatchObject({ status: 'working', turnOpen: true });
    next.reconcileProcesses(() => false);
    expect(c.last()).toMatchObject({ turnOpen: false });
  });

  it('a Codex app-server crash: the exit closes the turn; the old synthetic result is still sent', () => {
    startTurn('cx', 'codex');
    const c = client('cx');
    expect(c.frames[0]).toMatchObject({ status: 'working', turnOpen: true });
    // The app-server dies: the manager emits `exit`, and the harness event reaches the status service.
    c.mgr.emit('exit', 'cx', 1, 'app-server crashed');
    expect(status.accept(event('cx', 'process.exited', { exitCode: 1 }, 'codex'))).toBe(true);
    expect(c.last()).toMatchObject({ status: 'error', turnOpen: false });
    expect(c.frames.find((f) => f.type === 'result' && f.subtype === 'process_exit')).toMatchObject({ is_error: true });
  });

  it('a late frame of the dead process does not open the turn again', () => {
    startTurn('cc');
    const c = client('cc');
    expect(status.accept(event('cc', 'process.exited', { exitCode: 1 }))).toBe(true);
    const count = c.statusFrames().length;
    // The ring gets a late stream frame (a fold would latch busy on it). It is not a status.
    c.mgr.emit('event', 'cc', { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } });
    expect(c.statusFrames()).toHaveLength(count);
    expect(c.last()).toMatchObject({ turnOpen: false });
  });
});
