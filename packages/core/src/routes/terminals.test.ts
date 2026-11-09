import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTerminalsRouter } from './terminals.js';
import type { SessionService } from '../sessions/service.js';
import { modelSupportsTools } from '../settings/model-capabilities.js';

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
