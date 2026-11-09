import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTerminalsRouter } from './terminals.js';
import type { SessionService } from '../sessions/service.js';
import { modelSupportsTools } from '../settings/model-capabilities.js';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import * as parksDb from '../db/usage-limits.js';
import { StatusService } from '../status/service.js';

// The create route consults the model catalogs; stubbed so no test reaches the network.
vi.mock('../settings/model-capabilities.js', () => ({
  modelSupportsTools: vi.fn(async (id: string) => !id.includes('dolphin')),
}));

function app(stub: Partial<SessionService>) {
  const a = express();
  a.use(express.json());
  a.use('/api', createTerminalsRouter(stub as unknown as SessionService));
  return a;
}

describe('GET /api/terminals/:id/resume-advice', () => {
  it('returns the service payload', async () => {
    const advice = { shouldPrompt: true, ageMinutes: 180, contextTokens: 124_000 };
    const res = await request(app({ getResumeAdvice: () => advice })).get('/api/terminals/t1/resume-advice');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(advice);
  });

  it('answers a benign "no" when there is nothing to advise on', async () => {
    const res = await request(app({ getResumeAdvice: () => null })).get('/api/terminals/t1/resume-advice');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ shouldPrompt: false, ageMinutes: 0, contextTokens: 0 });
  });

  it('surfaces a service throw as 400', async () => {
    const res = await request(app({ getResumeAdvice: () => { throw new Error('boom'); } })).get('/api/terminals/t1/resume-advice');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('boom');
  });
});

describe('POST /api/terminals/:id/report-status', () => {
  it('forwards a valid declaration to the service', async () => {
    const reportStatus = vi.fn().mockReturnValue(true);
    const res = await request(app({ reportStatus }))
      .post('/api/terminals/t1/report-status')
      .send({ state: 'needs_you', summary: 'blocked on a decision', ask: 'Which provider?' });
    expect(res.status).toBe(204);
    expect(reportStatus).toHaveBeenCalledWith('t1', { state: 'needs_you', summary: 'blocked on a decision', ask: 'Which provider?' });
  });

  it('rejects an unknown state', async () => {
    const res = await request(app({ reportStatus: vi.fn() }))
      .post('/api/terminals/t1/report-status')
      .send({ state: 'vibes', summary: 'x' });
    expect(res.status).toBe(400);
  });

  it('answers 409 when no live structured session backs the thread', async () => {
    const res = await request(app({ reportStatus: vi.fn().mockReturnValue(false) }))
      .post('/api/terminals/t1/report-status')
      .send({ state: 'done', summary: 'shipped' });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/terminals/:id/board', () => {
  it('acknowledges a thread', async () => {
    const setBoardState = vi.fn().mockReturnValue(true);
    const res = await request(app({ setBoardState })).post('/api/terminals/t1/board').send({ acknowledged: true });
    expect(res.status).toBe(204);
    expect(setBoardState).toHaveBeenCalledWith('t1', { acknowledged: true });
  });

  it('sets a manual override', async () => {
    const setBoardState = vi.fn().mockReturnValue(true);
    const res = await request(app({ setBoardState })).post('/api/terminals/t1/board').send({ override: 'complete' });
    expect(res.status).toBe(204);
    expect(setBoardState).toHaveBeenCalledWith('t1', { override: 'complete' });
  });

  it('rejects an override of "working" — that is an observed fact, not a judgement', async () => {
    const res = await request(app({ setBoardState: vi.fn() })).post('/api/terminals/t1/board').send({ override: 'working' });
    expect(res.status).toBe(400);
  });

  it('404s an unknown terminal', async () => {
    const res = await request(app({ setBoardState: vi.fn().mockReturnValue(false) })).post('/api/terminals/t1/board').send({ acknowledged: true });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/sessions/:id/terminals — OpenCode tool support', () => {
  const CHAT_ONLY = 'openrouter/cognitivecomputations/dolphin-mistral-24b-venice-edition';
  const created = (config: Record<string, unknown>) => ({ id: 't-new', session_id: 's1', type: 'opencode', config: JSON.stringify(config) });

  it('pins toolsDisabled on a picked model that has no tool-capable endpoint', async () => {
    const createTerminal = vi.fn((_s, _t, _l, _skip, _wd, _ext, config) => created(config));
    const res = await request(app({ createTerminal: createTerminal as never }))
      .post('/api/sessions/s1/terminals')
      .send({ type: 'opencode', config: { transport: 'structured', model: CHAT_ONLY } });
    expect(res.status).toBe(201);
    expect(modelSupportsTools).toHaveBeenCalledWith(CHAT_ONLY);
    expect(createTerminal.mock.calls[0][6]).toEqual({ transport: 'structured', model: CHAT_ONLY, toolsDisabled: true });
  });

  it('leaves a tool-capable model alone', async () => {
    const createTerminal = vi.fn((_s, _t, _l, _skip, _wd, _ext, config) => created(config));
    await request(app({ createTerminal: createTerminal as never }))
      .post('/api/sessions/s1/terminals')
      .send({ type: 'opencode', config: { transport: 'structured', model: 'openrouter/~z-ai/glm-latest' } });
    expect(createTerminal.mock.calls[0][6]).toEqual({ transport: 'structured', model: 'openrouter/~z-ai/glm-latest' });
  });

  it('does not consult the catalog for another harness or an explicit verdict', async () => {
    vi.mocked(modelSupportsTools).mockClear();
    const createTerminal = vi.fn((_s, _t, _l, _skip, _wd, _ext, config) => created(config));
    await request(app({ createTerminal: createTerminal as never }))
      .post('/api/sessions/s1/terminals')
      .send({ type: 'claude-code', config: { transport: 'structured', model: 'opus' } });
    await request(app({ createTerminal: createTerminal as never }))
      .post('/api/sessions/s1/terminals')
      .send({ type: 'opencode', config: { transport: 'structured', model: CHAT_ONLY, toolsDisabled: false } });
    expect(modelSupportsTools).not.toHaveBeenCalled();
    expect(createTerminal.mock.calls[1][6]).toEqual({ transport: 'structured', model: CHAT_ONLY, toolsDisabled: false });
  });
});

// W1-D item 3: a message POST with an `Idempotency-Key` header is delivered once.
describe('POST /api/terminals/:id/message — Idempotency-Key', () => {
  const stubs = (over: Partial<Record<string, unknown>> = {}) => {
    const sendThreadMessage = vi.fn((_id: string, body: unknown) => ({ transport: 'structured', delivered: body }));
    const stub = {
      handleTypedSlash: vi.fn(async () => null),
      sendThreadMessage,
      noteUserPrompt: vi.fn(),
      noteUserMessageToAgent: vi.fn(),
      getTerminal: () => ({ id: 't1', sessionId: 's1' }),
      ...over,
    };
    return { stub, sendThreadMessage, a: app(stub as unknown as Partial<SessionService>) };
  };
  const post = (a: express.Express, id: string, key?: string, text = 'hello') => {
    const r = request(a).post(`/api/terminals/${id}/message`);
    if (key) r.set('Idempotency-Key', key);
    return r.send({ text, source: 'user' });
  };

  it('two POSTs with one key deliver once', async () => {
    const { a, sendThreadMessage, stub } = stubs();
    const first = await post(a, 't1', 'key-1');
    const second = await post(a, 't1', 'key-1');
    expect(first.status).toBe(204);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ duplicate: true });
    expect(sendThreadMessage).toHaveBeenCalledTimes(1);
    // The side effects of a delivery run once too (the thread namer, the note to the coordinator).
    expect(stub.noteUserPrompt).toHaveBeenCalledTimes(1);
    expect(stub.noteUserMessageToAgent).toHaveBeenCalledTimes(1);
    // A third copy is still a duplicate.
    expect((await post(a, 't1', 'key-1')).body).toEqual({ duplicate: true });
    expect(sendThreadMessage).toHaveBeenCalledTimes(1);
  });

  it('a POST with no key delivers every time', async () => {
    const { a, sendThreadMessage } = stubs();
    expect((await post(a, 't1')).status).toBe(204);
    expect((await post(a, 't1')).status).toBe(204);
    expect(sendThreadMessage).toHaveBeenCalledTimes(2);
  });

  it('a different key delivers, and the same key on another thread delivers', async () => {
    const { a, sendThreadMessage } = stubs();
    expect((await post(a, 't1', 'key-1')).status).toBe(204);
    expect((await post(a, 't1', 'key-2')).status).toBe(204);
    expect((await post(a, 't2', 'key-1')).status).toBe(204);
    expect(sendThreadMessage).toHaveBeenCalledTimes(3);
  });

  it('a second POST that arrives while the first is in flight answers 409 in_flight', async () => {
    let finish!: (v: null) => void;
    const { a, sendThreadMessage } = stubs({ handleTypedSlash: vi.fn(() => new Promise<null>((r) => { finish = r; })) });
    const first = post(a, 't1', 'key-1').then((r) => r);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const second = await post(a, 't1', 'key-1');
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: 'in_flight' });
    finish(null);
    expect((await first).status).toBe(204);
    expect(sendThreadMessage).toHaveBeenCalledTimes(1);
    // After the first is done, the same key is a duplicate.
    expect((await post(a, 't1', 'key-1')).body).toEqual({ duplicate: true });
  });

  it('a send that failed is not remembered: the same key runs again', async () => {
    const sendThreadMessage = vi.fn()
      .mockImplementationOnce(() => { throw new Error('the thread is not running'); })
      .mockImplementation(() => ({ transport: 'structured' }));
    const { a } = stubs({ sendThreadMessage });
    const first = await post(a, 't1', 'key-1');
    expect(first.status).toBe(400);
    const second = await post(a, 't1', 'key-1');
    expect(second.status).toBe(204);
    expect(sendThreadMessage).toHaveBeenCalledTimes(2);
  });

  it('a request that fails validation does not use up its key', async () => {
    const { a, sendThreadMessage } = stubs();
    const bad = await request(a).post('/api/terminals/t1/message').set('Idempotency-Key', 'key-1').send({ text: '' });
    expect(bad.status).toBe(400);
    expect((await post(a, 't1', 'key-1')).status).toBe(204);
    expect(sendThreadMessage).toHaveBeenCalledTimes(1);
  });

  it('a typed settings command with a key runs once and the copy gets the first answer', async () => {
    const handleTypedSlash = vi.fn(async () => ({ sessionId: 's1' }));
    const { a, sendThreadMessage } = stubs({ handleTypedSlash });
    const first = await post(a, 't1', 'key-1', '/model opus');
    const second = await post(a, 't1', 'key-1', '/model opus');
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ handled: 'settings' });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ handled: 'settings', duplicate: true });
    expect(handleTypedSlash).toHaveBeenCalledTimes(1);
    expect(sendThreadMessage).not.toHaveBeenCalled();
  });

  it('a key that is too long is refused', async () => {
    const { a, sendThreadMessage } = stubs();
    const res = await post(a, 't1', 'k'.repeat(201));
    expect(res.status).toBe(400);
    expect(sendThreadMessage).not.toHaveBeenCalled();
  });
});

// W1-D item 1: the flags of the stall watchdog, for a client that just connected.
describe('GET /api/terminals/stalls', () => {
  it('returns the flags of the stall watchdog', async () => {
    const a = app({ getTerminal: () => { throw new Error('the :terminalId route must not take this request'); } });
    const all = [{ terminalId: 't1', stalledSince: 1_700_000_000_000, lastFrameAt: null }];
    a.locals.stallWatchdog = { all: () => all };
    const res = await request(a).get('/api/terminals/stalls');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(all);
  });

  it('returns an empty list when no watchdog runs', async () => {
    const res = await request(app({})).get('/api/terminals/stalls');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// W2-G: the diagnostics route explains why a thread is in its state. Real database and real
// StatusService; the process, the watchdog, the outbox and the saved questions are stand-ins.
describe('GET /api/terminals/:id/diagnostics', () => {
  const NOW = Date.now();
  function world(opts: { transport?: 'structured' | 'pty'; alive?: boolean; pending?: unknown } = {}) {
    const db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 'proj', provider: 'claude-code', name: 'p', workingDir: '/x' });
    const transport = opts.transport ?? 'structured';
    terminalsDb.create(db, { id: 't1', sessionId: 'proj', type: 'claude-code', label: 'Worker', skipPermissions: true, config: { transport } });
    terminalsDb.create(db, { id: 'coord', sessionId: 'proj', type: 'claude-code', label: 'Control Plane', skipPermissions: true });
    const status = new StatusService(db, { broadcast: vi.fn() });
    const state = { alive: opts.alive ?? true, pending: opts.pending ?? null };
    const manager = { isAlive: () => state.alive, getPending: () => state.pending };
    const session = {
      getTerminal: (id: string) => { const row = terminalsDb.getById(db, id); return row ? terminalsDb.rowToTerminal(row) : null; },
      structuredManagerFor: () => (transport === 'structured' ? manager : undefined),
      getPendingPermission: () => (transport === 'structured' ? state.pending : null),
      ptyManager: { isAlive: () => state.alive },
    };
    const a = express();
    a.use(express.json());
    a.use('/api', createTerminalsRouter(session as unknown as SessionService, undefined, status));
    const get = async () => (await request(a).get('/api/terminals/t1/diagnostics')).body;
    return { db, status, state, a, get };
  }

  it('answers 404 for a thread that is not known', async () => {
    const res = await request(app({ getTerminal: () => null as never })).get('/api/terminals/nope/diagnostics');
    expect(res.status).toBe(404);
  });

  it('diagnostics answers with empty deliveries when no outbox is wired', async () => {
    const { get } = world();
    const body = await get();
    expect(body.deliveries).toEqual([]);
    expect(body.stall).toBeNull();
    expect(body.park).toBeNull();
    expect(body.pendingQuestion).toBeNull();
    // The fields of the route before W2-G are still there.
    expect(body).toHaveProperty('lifecycle');
    expect(body).toHaveProperty('captureFailure');
    expect(Array.isArray(body.events)).toBe(true);
  });

  it('it includes the explanation', async () => {
    const { get } = world();
    const body = await get();
    expect(body.status).toBe('idle');
    expect(body.process).toEqual({ alive: true, transport: 'structured' });
    expect(body.explanation).toMatchObject({ rule: 'idle', headline: 'Waiting for your next message', nextSteps: [] });
    expect(Array.isArray(body.explanation.reasons)).toBe(true);
  });

  it('it still answers, with a plain explanation, when no status service and no process source exist', async () => {
    const res = await request(app({ getTerminal: () => ({ id: 't1', type: 'claude-code', status: 'working', config: {} }) as never })).get('/api/terminals/t1/diagnostics');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ lifecycle: null, captureFailure: null, events: [], process: null, deliveries: [], status: 'working' });
    expect(res.body.explanation.rule).toBe('working');
  });

  it('working with a live process: a turn is in progress', async () => {
    const { status, get } = world();
    status.markWorking('t1');
    const body = await get();
    expect(body.status).toBe('working');
    expect(body.explanation.rule).toBe('working');
    expect(body.explanation.since).toBe(body.events.at(-1).observed_at);
  });

  // Regression (1A.2, stale working status): the explanation names the dead process, and the reset works.
  it('a working thread whose process is dead is explained and can be reset', async () => {
    const { status, state, a, get, db } = world();
    status.markWorking('t1');
    state.alive = false;
    const body = await get();
    expect(body.process).toEqual({ alive: false, transport: 'structured' });
    expect(body.explanation.rule).toBe('working-dead-process');
    expect(body.explanation.headline).toBe('Working, but the process ended');
    expect(body.explanation.nextSteps.map((s: { action: string }) => s.action)).toEqual(['reset-status', 'restart']);
    // The route only reads: the status did not change.
    expect(terminalsDb.getById(db, 't1')?.status).toBe('working');
    expect((await request(a).post('/api/terminals/t1/reset-status')).status).toBe(204);
    const after = await get();
    expect(after.status).toBe('idle');
    expect(after.explanation.rule).toBe('idle');
    expect(after.events[0].event_type).toBe('status.reset');
  });

  it('a CLI thread reads its process from the PTY manager', async () => {
    const { status, get } = world({ transport: 'pty', alive: false });
    status.markWorking('t1');
    const body = await get();
    expect(body.process).toEqual({ alive: false, transport: 'pty' });
    expect(body.explanation.rule).toBe('working-dead-process');
  });

  it('stalled: the flag of the watchdog is in the answer and in the explanation', async () => {
    const { status, a, get } = world();
    status.markWorking('t1');
    const since = NOW - 14 * 60_000;
    a.locals.stallWatchdog = { all: () => [], get: (id: string) => (id === 't1' ? { terminalId: 't1', stalledSince: since, lastFrameAt: since } : null) };
    const body = await get();
    expect(body.stall).toEqual({ stalledSince: new Date(since).toISOString(), lastFrameAt: new Date(since).toISOString() });
    expect(body.explanation.rule).toBe('working-stalled');
    expect(body.explanation.reasons.join(' ')).toContain('The watchdog only flags the thread');
  });

  it('needs input with a live question', async () => {
    const { status, get } = world({ pending: { requestId: 'r1', toolName: 'AskUserQuestion', input: { secret: 'question body' }, questions: [{ question: 'Which one?' }] } });
    status.markNeedsInput('t1', 'Needs your answer');
    const body = await get();
    expect(body.status).toBe('needs_input');
    expect(body.pendingQuestion).toEqual({ source: 'live', toolName: 'AskUserQuestion', question: true, createdAt: null });
    expect(body.explanation.rule).toBe('needs-input-question');
    expect(JSON.stringify(body)).not.toContain('question body');
    expect(JSON.stringify(body)).not.toContain('Which one?');
  });

  it('needs input with a question that the saved-question table restored (W2-C source)', async () => {
    const { status, state, a, get } = world();
    status.markNeedsInput('t1', 'Needs your answer');
    state.alive = false;
    a.locals.pendingQuestions = { get: (id: string) => (id === 't1' ? { terminal_id: 't1', request_id: 'r1', payload: '{"q":"saved body"}', created_at: '2026-11-09T10:00:00.000Z' } : null) };
    const body = await get();
    expect(body.pendingQuestion).toEqual({ source: 'saved', toolName: null, question: true, createdAt: '2026-11-09T10:00:00.000Z' });
    expect(body.explanation.rule).toBe('needs-input-restored-question');
    expect(JSON.stringify(body)).not.toContain('saved body');
  });

  it('error with a dead process', async () => {
    const { status, state, get } = world();
    status.markWorking('t1');
    state.alive = false;
    status.markExited('t1', 1);
    const body = await get();
    expect(body.status).toBe('error');
    expect(body.explanation.rule).toBe('error-dead-process');
  });

  it('parked on a limit: the park row is in the answer without its banner text', async () => {
    const { db, get } = world();
    const resets = NOW + 2 * 3600_000;
    parksDb.upsert(db, { terminal_id: 't1', provider: 'claude-code', kind: 'session', resets_at: resets, wake_at: resets + 60_000, message: 'limit banner words', parsed: 1, attempts: 0, state: 'parked', parked_at: NOW - 60_000 }, NOW);
    const body = await get();
    expect(body.park).toEqual({ state: 'parked', provider: 'claude-code', kind: 'session', resetsAt: resets, wakeAt: resets + 60_000, attempts: 0, parkedAt: NOW - 60_000 });
    expect(body.explanation.rule).toBe('parked-limit');
    expect(body.explanation.nextSteps).toEqual([{ label: 'Open usage limits', action: 'open-usage' }]);
    expect(JSON.stringify(body)).not.toContain('limit banner words');
  });

  it('queued', async () => {
    const { db, state, get } = world();
    state.alive = false;
    terminalsDb.updateStatus(db, 't1', 'queued');
    const body = await get();
    expect(body.status).toBe('queued');
    expect(body.explanation.rule).toBe('queued');
  });

  it('deliveries: the last 20 of the outbox, to and from the thread, with the peer label and no body', async () => {
    const { a, get } = world();
    const list = vi.fn(() => [
      { id: 2, target_terminal_id: 'coord', source_terminal_id: 't1', kind: 'notice', body: 'worker output words', dedup_key: 'k2', state: 'pending', attempts: 1, last_error: 'not-alive', created_at: '2026-11-09T10:00:00.000Z', delivered_at: null },
      { id: 1, target_terminal_id: 't1', source_terminal_id: 'coord', kind: 'watch', body: 'x', dedup_key: 'k1', state: 'delivered', attempts: 1, last_error: null, created_at: '2026-11-09T09:00:00.000Z', delivered_at: '2026-11-09T09:00:01.000Z' },
      ...Array.from({ length: 30 }, (_, n) => ({ id: 100 + n, target_terminal_id: 't1', source_terminal_id: null, kind: 'notice', body: 'x', dedup_key: `d${n}`, state: 'delivered', attempts: 1, last_error: null, created_at: null, delivered_at: null })),
    ]);
    a.locals.deliveryOutbox = { list };
    const body = await get();
    expect(list).toHaveBeenCalledWith({ terminalId: 't1', limit: 20 });
    expect(body.deliveries).toHaveLength(20);
    expect(body.deliveries[0]).toEqual({ id: 2, direction: 'from', peerId: 'coord', peerLabel: 'Control Plane', kind: 'notice', state: 'pending', attempts: 1, lastError: 'not-alive', createdAt: '2026-11-09T10:00:00.000Z', deliveredAt: null });
    expect(body.deliveries[1]).toMatchObject({ id: 1, direction: 'to', peerId: 'coord', state: 'delivered' });
    expect(body.explanation.rule).toBe('idle-pending-delivery');
    expect(body.explanation.reasons.join(' ')).toContain('A notice for the thread "Control Plane" (coord) waits');
    expect(JSON.stringify(body)).not.toContain('worker output words');
  });

  it('a source that throws does not break the answer', async () => {
    const { a, get } = world();
    a.locals.deliveryOutbox = { list: () => { throw new Error('outbox closed'); } };
    a.locals.stallWatchdog = { all: () => [], get: () => { throw new Error('boom'); } };
    a.locals.pendingQuestions = { get: () => { throw new Error('boom'); } };
    const body = await get();
    expect(body.deliveries).toEqual([]);
    expect(body.stall).toBeNull();
    expect(body.explanation.rule).toBe('idle');
  });
});
