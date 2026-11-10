// hasRenderableEvents mirrors the client fold (useStructuredChat's onEvent): an event is
// renderable iff it would produce a visible conversation item. The `system/inactive`
// REST-hydration sentinel fires when the ring holds NO renderable events — covering the
// empty ring AND the 0b8e106 deadlock ring (system/init + system/status + a stale result),
// which is non-empty yet renders nothing.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';
import { hasRenderableEvents } from './structured.js';

describe('hasRenderableEvents', () => {
  it('empty ring → false (sentinel fires, same as the old events.length === 0 check)', () => {
    expect(hasRenderableEvents([])).toBe(false);
  });

  it('the 0b8e106 deadlock ring (init + status + stale result) → false', () => {
    expect(hasRenderableEvents([
      { type: 'system', subtype: 'init', model: 'claude-sonnet-5' },
      { type: 'system', subtype: 'status', status: null },
      { type: 'result', is_error: false },
    ])).toBe(false);
  });

  it('an assistant event with a text block → true', () => {
    expect(hasRenderableEvents([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
    ])).toBe(true);
  });

  it('assistant thinking / tool_use / image blocks → true', () => {
    expect(hasRenderableEvents([{ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hm' }] } }])).toBe(true);
    expect(hasRenderableEvents([{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 't1', input: {} }] } }])).toBe(true);
    expect(hasRenderableEvents([{ type: 'assistant', message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }] } }])).toBe(true);
  });

  it('an assistant event with empty/whitespace-only text and no other blocks → false', () => {
    expect(hasRenderableEvents([{ type: 'assistant', message: { content: [] } }])).toBe(false);
    expect(hasRenderableEvents([{ type: 'assistant', message: { content: [{ type: 'text', text: '   ' }] } }])).toBe(false);
  });

  it('a user event with non-empty string content → true; whitespace-only → false', () => {
    expect(hasRenderableEvents([{ type: 'user', message: { role: 'user', content: 'hello' } }])).toBe(true);
    expect(hasRenderableEvents([{ type: 'user', message: { role: 'user', content: '   ' } }])).toBe(false);
  });

  it('a user event with tool_result / text / image blocks → true; empty array → false', () => {
    expect(hasRenderableEvents([{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }])).toBe(true);
    expect(hasRenderableEvents([{ type: 'user', message: { content: [{ type: 'text', text: 'q' }] } }])).toBe(true);
    expect(hasRenderableEvents([{ type: 'user', message: { content: [] } }])).toBe(false);
  });

  it('isSynthetic / isMeta user events are skipped by the client → false', () => {
    expect(hasRenderableEvents([{ type: 'user', isSynthetic: true, message: { content: 'injected skill ctx' } }])).toBe(false);
    expect(hasRenderableEvents([{ type: 'user', isMeta: true, message: { content: 'reminder' } }])).toBe(false);
  });

  it('a stream_event content_block_start → true; deltas/message_start alone → false', () => {
    expect(hasRenderableEvents([{ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } }])).toBe(true);
    expect(hasRenderableEvents([
      { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } },
    ])).toBe(false);
  });

  it('control_request / rate_limit_event / permission-ish noise → false', () => {
    expect(hasRenderableEvents([
      { type: 'control_request', request: { subtype: 'can_use_tool' } },
      { type: 'rate_limit_event' },
    ])).toBe(false);
  });

  it('garbage entries (null, non-objects) are ignored', () => {
    expect(hasRenderableEvents([null, 42, 'nope'])).toBe(false);
  });
});

// ---- REST-owned history (Codex) ----
//
// A Codex thread's history lives in its rollout transcript, which the client can page over
// REST. Its ring ALSO holds a copy, backfilled on resume. Replaying that copy would render
// the same turns twice, and unlike Claude there is no per-message uuid to dedup on — a
// Codex item carries none, so the client's dedup would fall back to a content fingerprint
// that does not match across the two translators for tool calls. So: replay nothing, and
// let the `system/inactive` sentinel hand the whole view to REST.

import { handleStructuredConnection } from './structured.js';

function fakeWs() {
  const sent: any[] = [];
  return {
    ws: { readyState: 1, send: (s: string) => sent.push(JSON.parse(s)), close: () => {}, on: () => {} } as any,
    sent,
  };
}
const ringManager = (events: unknown[]) => ({
  getEvents: () => events,
  getEventsTail: (_id: string, n: number) => events.slice(-n),
  getPending: () => null,
  on: () => {}, off: () => {},
}) as any;

const REAL_TURN = { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } };
const REQ = { url: '/api/terminals/t1/structured-ws?tail=200' } as any;

describe('replay when REST owns the thread history', () => {
  it('replays no ring events and sends the inactive sentinel instead', () => {
    const { ws, sent } = fakeWs();
    handleStructuredConnection(ws, REQ, ringManager([REAL_TURN]), undefined, () => true);

    expect(sent).toEqual([{ type: 'system', subtype: 'inactive' }]);
  });

  it('still replays the ring for a thread REST does not own', () => {
    const { ws, sent } = fakeWs();
    handleStructuredConnection(ws, REQ, ringManager([REAL_TURN]), undefined, () => false);

    expect(sent).toEqual([REAL_TURN]);
  });

  it('replays the ring when no predicate is supplied at all (unchanged default)', () => {
    const { ws, sent } = fakeWs();
    handleStructuredConnection(ws, REQ, ringManager([REAL_TURN]));

    expect(sent).toEqual([REAL_TURN]);
  });

  it('treats a throwing predicate as "not REST-owned" rather than dropping the history', () => {
    const { ws, sent } = fakeWs();
    handleStructuredConnection(ws, REQ, ringManager([REAL_TURN]), undefined, () => { throw new Error('db gone'); });

    expect(sent).toEqual([REAL_TURN]);
  });
});

// ---- The tail bound vs harnesses REST cannot page (Grok) ----
//
// `?tail=N` exists so a long Claude thread opens fast — anything the tail cuts is
// recoverable through REST paging (loadOlder). Grok has NO pageable transcript
// (getConversation → unsupported), so for it the tail bound silently AMPUTATES history:
// one chatty turn (~1600 word-delta events) pushed the whole conversation above the
// 200-event tail and a reopened thread showed nothing but the result footer.

describe('tail bound applies only when REST can page what it cuts', () => {
  const bigRing = Array.from({ length: 500 }, (_, i) => ({
    type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `w${i}` } },
  }));

  it('replays the FULL ring, ignoring tail, when restCanPageHistory says false', () => {
    const { ws, sent } = fakeWs();
    handleStructuredConnection(ws, REQ, ringManager(bigRing), undefined, () => false, () => false);
    // sentinel may precede the replay (deltas alone are non-renderable); the replay itself
    // must be the WHOLE ring, not the last 200.
    expect(sent.filter((e) => e.type === 'stream_event')).toHaveLength(500);
  });

  it('keeps the bounded tail when restCanPageHistory says true (Claude)', () => {
    const { ws, sent } = fakeWs();
    handleStructuredConnection(ws, REQ, ringManager(bigRing), undefined, () => false, () => true);
    expect(sent.filter((e) => e.type === 'stream_event')).toHaveLength(200);
  });

  it('keeps the bounded tail when no predicate is supplied (unchanged default)', () => {
    const { ws, sent } = fakeWs();
    handleStructuredConnection(ws, REQ, ringManager(bigRing), undefined, () => false);
    expect(sent.filter((e) => e.type === 'stream_event')).toHaveLength(200);
  });

  it('a throwing predicate falls back to the FULL replay — never amputate on error', () => {
    const { ws, sent } = fakeWs();
    handleStructuredConnection(ws, REQ, ringManager(bigRing), undefined, () => false, () => { throw new Error('db gone'); });
    expect(sent.filter((e) => e.type === 'stream_event')).toHaveLength(500);
  });
});

// ---- Stuck "Working…" after replay ----------------------------------------------------------
//
// stream_event / whole-assistant events set the client's busy=true; only a `result` (or a
// `permission`) clears it. A ring can legitimately END on busy-setting events — a process
// killed mid-turn never wrote its closing result, and a tail can slice mid-turn — so a
// reconnect replayed "Working…" forever on a thread the daemon itself knew was settled.
// When the replay would leave busy latched AND the thread is not actually working, the
// handler appends the synthetic settle the client swallows (subtype 'backfill').

const MID_TURN_RING = [
  { type: 'user', message: { role: 'user', content: 'go' } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } } },
];

describe('replay settle for rings that end mid-turn', () => {
  it('appends a backfill result when the ring ends busy and the thread is settled', () => {
    const { ws, sent } = fakeWs();
    handleStructuredConnection(ws, REQ, ringManager(MID_TURN_RING), undefined, undefined, undefined, () => true);
    expect(sent[sent.length - 1]).toMatchObject({ type: 'result', subtype: 'backfill', is_error: false });
  });

  it('appends nothing while the thread is genuinely working — busy is TRUE truth there', () => {
    const { ws, sent } = fakeWs();
    handleStructuredConnection(ws, REQ, ringManager(MID_TURN_RING), undefined, undefined, undefined, () => false);
    expect(sent.some((e) => e.subtype === 'backfill')).toBe(false);
  });

  it('appends nothing when the ring already settles itself (ends with a result)', () => {
    const { ws, sent } = fakeWs();
    const ring = [...MID_TURN_RING, { type: 'result', subtype: 'x_turn', is_error: false }];
    handleStructuredConnection(ws, REQ, ringManager(ring), undefined, undefined, undefined, () => true);
    expect(sent.some((e) => e.subtype === 'backfill')).toBe(false);
  });

  it('appends nothing without the predicate (no authority on settledness → no guess)', () => {
    const { ws, sent } = fakeWs();
    handleStructuredConnection(ws, REQ, ringManager(MID_TURN_RING));
    expect(sent.some((e) => e.subtype === 'backfill')).toBe(false);
  });

  it('a pending permission at the ring tail also counts as settled-for-busy (the client shows the card, not the spinner)', () => {
    const { ws, sent } = fakeWs();
    const ring = [...MID_TURN_RING];
    const manager = { ...ringManager(ring), getPending: () => ({ requestId: 'r1', toolName: 'AskUserQuestion', input: {} }) } as any;
    handleStructuredConnection(ws, REQ, manager, undefined, undefined, undefined, () => true);
    // The replayed pending permission frame already clears busy client-side; no settle needed.
    expect(sent.some((e) => e.subtype === 'backfill')).toBe(false);
  });
});

describe('replay back-pressure', () => {
  afterEach(() => { vi.useRealTimers(); delete process.env.DISPATCH_WS_MAX_BUFFERED_BYTES; delete process.env.DISPATCH_WS_BUFFER_GRACE_MS; vi.restoreAllMocks(); });

  it('drops a client that never reads a big replay, with no later live event needed', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.DISPATCH_WS_MAX_BUFFERED_BYTES = '1000';
    process.env.DISPATCH_WS_BUFFER_GRACE_MS = '2000';
    const events = Array.from({ length: 5 }, (_, i) => ({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(500) + i }] } }));
    const manager = Object.assign(new EventEmitter(), {
      getEvents: () => events, getEventsTail: () => events, getPending: () => null,
    }) as any;
    const ws = Object.assign(new EventEmitter(), {
      readyState: 1, bufferedAmount: 0, send: vi.fn(function (this: any, d: string) { this.bufferedAmount += d.length; }), terminate: vi.fn(), close: vi.fn(),
    }) as unknown as WebSocket;
    handleStructuredConnection(ws, { url: '/api/terminals/t1/structured-ws' } as any, manager);
    expect((ws as any).send.mock.calls.length).toBeLessThan(5); // paced: it stopped sending once the queue was over half the limit
    await vi.advanceTimersByTimeAsync(2100);
    expect((ws as any).terminate).toHaveBeenCalledTimes(1);
  });

  it('sends a big history in step with the free buffer space, never past the limit, then the live event held meanwhile, in order', async () => {
    vi.useFakeTimers();
    process.env.DISPATCH_WS_MAX_BUFFERED_BYTES = '1000';
    process.env.DISPATCH_WS_BUFFER_GRACE_MS = '5000';
    const events = Array.from({ length: 20 }, (_, i) => ({ type: 'assistant', message: { content: [{ type: 'text', text: `${i}`.padEnd(200, 'x') }] } }));
    const manager = Object.assign(new EventEmitter(), { getEvents: () => events, getEventsTail: () => events, getPending: () => null }) as any;
    let peak = 0;
    const sent: string[] = [];
    const ws = Object.assign(new EventEmitter(), {
      readyState: 1, bufferedAmount: 0, terminate: vi.fn(), close: vi.fn(),
      send: vi.fn(function (this: any, d: string) { sent.push(d); this.bufferedAmount += d.length; peak = Math.max(peak, this.bufferedAmount); }),
    }) as any;
    handleStructuredConnection(ws as WebSocket, { url: '/api/terminals/t1/structured-ws' } as any, manager);
    manager.emit('event', 't1', { type: 'assistant', message: { content: [{ type: 'text', text: 'LIVE' }] } });
    // The client reads 150 bytes every 25 ms.
    for (let i = 0; i < 400 && sent.length < 21; i++) {
      await vi.advanceTimersByTimeAsync(25);
      ws.bufferedAmount = Math.max(0, ws.bufferedAmount - 150);
    }
    expect(sent).toHaveLength(21);
    expect(sent[20]).toContain('LIVE'); // held until the history was out
    expect(sent.slice(0, 20).every((m, i) => m.includes(`"text":"${i}`))).toBe(true);
    expect(peak).toBeLessThanOrEqual(500 + 400); // half the limit plus one frame
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it('a history bigger than the hard ceiling still loads on a slow reading client (it does not hit the ceiling)', async () => {
    vi.useFakeTimers();
    process.env.DISPATCH_WS_MAX_BUFFERED_BYTES = '1000'; // ceiling 4000
    process.env.DISPATCH_WS_BUFFER_GRACE_MS = '5000';
    const events = Array.from({ length: 60 }, (_, i) => ({ type: 'assistant', message: { content: [{ type: 'text', text: `${i}`.padEnd(200, 'x') }] } })); // ~16 KB in all
    const manager = Object.assign(new EventEmitter(), { getEvents: () => events, getEventsTail: () => events, getPending: () => null }) as any;
    let count = 0;
    const ws = Object.assign(new EventEmitter(), {
      readyState: 1, bufferedAmount: 0, terminate: vi.fn(), close: vi.fn(),
      send: vi.fn(function (this: any, d: string) { count++; this.bufferedAmount += d.length; }),
    }) as any;
    handleStructuredConnection(ws as WebSocket, { url: '/api/terminals/t1/structured-ws' } as any, manager);
    for (let i = 0; i < 1000 && count < 60; i++) { await vi.advanceTimersByTimeAsync(25); ws.bufferedAmount = Math.max(0, ws.bufferedAmount - 100); }
    expect(count).toBe(60);
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  const mkManager = (events: unknown[]) => Object.assign(new EventEmitter(), { getEvents: () => events, getEventsTail: () => events, getPending: () => null }) as any;
  const textEvent = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

  it('sends the held live events through the same pacer: 4 history + 60 live frames reach a reading client without the hard ceiling', async () => {
    vi.useFakeTimers();
    process.env.DISPATCH_WS_MAX_BUFFERED_BYTES = '2000'; // ceiling 8000; the 60 held frames (about 4.5 KB) fit under the held bound
    process.env.DISPATCH_WS_BUFFER_GRACE_MS = '5000';
    const history = Array.from({ length: 4 }, (_, i) => textEvent(`h${i}`.padEnd(150, 'x')));
    const manager = mkManager(history);
    let count = 0; let peak = 0;
    const ws = Object.assign(new EventEmitter(), {
      readyState: 1, bufferedAmount: 1500, terminate: vi.fn(), close: vi.fn(), // a slow client: over half the limit, so the replay must wait
      send: vi.fn(function (this: any) { count++; this.bufferedAmount += 200; peak = Math.max(peak, this.bufferedAmount); }),
    }) as any;
    handleStructuredConnection(ws as WebSocket, { url: '/api/terminals/t1/structured-ws' } as any, manager);
    // Sixty live events arrive while the history is still waiting for room: they are held, then paced out behind it.
    for (let i = 0; i < 60; i++) manager.emit('event', 't1', textEvent(`live${i}`));
    for (let i = 0; i < 3000 && count < 64; i++) { await vi.advanceTimersByTimeAsync(10); ws.bufferedAmount = Math.max(0, ws.bufferedAmount - 150); }
    expect(count).toBe(64);
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(peak).toBeLessThan(8000);
  });

  it('bounds the held live events by bytes: a client that cannot keep up with the replay is dropped, not buffered for', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.DISPATCH_WS_MAX_BUFFERED_BYTES = '1000';
    process.env.DISPATCH_WS_BUFFER_GRACE_MS = '600000';
    const manager = mkManager([textEvent('h'.repeat(300)), textEvent('h'.repeat(300))]);
    const ws = Object.assign(new EventEmitter(), {
      readyState: 1, bufferedAmount: 0, terminate: vi.fn(function (this: any) { this.readyState = 3; }), close: vi.fn(),
      send: vi.fn(function (this: any, d: string) { this.bufferedAmount += d.length; }),
    }) as any;
    handleStructuredConnection(ws as WebSocket, { url: '/api/terminals/t1/structured-ws' } as any, manager);
    // The client reads nothing (and the grace is long, so the replay itself keeps waiting). Live output keeps coming.
    for (let i = 0; i < 100 && ws.terminate.mock.calls.length === 0; i++) manager.emit('event', 't1', textEvent('L'.repeat(100))); // held limit is 4 x 1000 bytes
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    const sentBefore = ws.send.mock.calls.length;
    manager.emit('event', 't1', textEvent('more'));
    await vi.advanceTimersByTimeAsync(100);
    expect(ws.send.mock.calls.length).toBe(sentBefore); // nothing more is queued for the dropped client
  });

  it('counts the held live events in bytes: CJK text (3 bytes a character) hits the bound that its character count would miss', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.DISPATCH_WS_MAX_BUFFERED_BYTES = '1000'; // held bound: 4000 bytes
    process.env.DISPATCH_WS_BUFFER_GRACE_MS = '600000';
    const manager = mkManager([textEvent('h')]);
    const ws = Object.assign(new EventEmitter(), {
      readyState: 1, bufferedAmount: 1500, terminate: vi.fn(function (this: any) { this.readyState = 3; }), close: vi.fn(), // replay waits
      send: vi.fn(),
    }) as any;
    handleStructuredConnection(ws as WebSocket, { url: '/api/terminals/t1/structured-ws' } as any, manager);
    const cjk = textEvent('汉'.repeat(300)); // about 960 bytes of JSON, but only about 350 UTF-16 units
    expect(JSON.stringify(cjk).length).toBeLessThan(400);
    for (let i = 0; i < 3; i++) manager.emit('event', 't1', cjk); // 3 x 960 = 2.9 KB: under 4000 bytes
    expect(ws.terminate).not.toHaveBeenCalled();
    for (let i = 0; i < 2; i++) manager.emit('event', 't1', cjk); // 5 x 960 = 4.8 KB: over the bound (1.75 KB by character count)
    expect(ws.terminate).toHaveBeenCalledTimes(1);
  });
});

// ---- The active model on (re)connect ----
//
// Claude Code emits system/init once per TURN, so a bounded tail (or a just-spawned process with
// no turn yet, or a Codex thread whose ring is never replayed) left the Pretty header with no
// model or the previous transport's one. The handler now ends the replay with the model the
// daemon knows the thread runs NOW, so it wins over any older frame in the replay.
describe('the active model frame', () => {
  it('ends the replay with the current model, after the ring', () => {
    const { ws, sent } = fakeWs();
    handleStructuredConnection(ws, REQ, ringManager([REAL_TURN]), undefined, undefined, undefined, undefined, () => 'claude-opus-5-5');
    expect(sent).toEqual([REAL_TURN, { type: 'system', subtype: 'model', model: 'claude-opus-5-5' }]);
  });

  it('is sent for a REST-owned thread too (no ring replay)', () => {
    const { ws, sent } = fakeWs();
    handleStructuredConnection(ws, REQ, ringManager([REAL_TURN]), undefined, () => true, undefined, undefined, () => 'gpt-5.6-luna');
    expect(sent).toEqual([{ type: 'system', subtype: 'inactive' }, { type: 'system', subtype: 'model', model: 'gpt-5.6-luna' }]);
  });

  it('is left out when no model is known, and a throwing lookup never breaks the replay', () => {
    const a = fakeWs();
    handleStructuredConnection(a.ws, REQ, ringManager([REAL_TURN]), undefined, undefined, undefined, undefined, () => undefined);
    expect(a.sent).toEqual([REAL_TURN]);
    const b = fakeWs();
    handleStructuredConnection(b.ws, REQ, ringManager([REAL_TURN]), undefined, undefined, undefined, undefined, () => { throw new Error('db gone'); });
    expect(b.sent).toEqual([REAL_TURN]);
  });
});


// W2-C: a question asked before a daemon restart is in the database, not in the manager.
describe('handleStructuredConnection: a question saved before a restart', () => {
  const SAVED = { requestId: 'req-1', toolName: 'AskUserQuestion', input: {}, questions: [{ question: 'Deploy now?' }] };

  it('sends the saved question as the same permission frame, after the replay', () => {
    const { ws, sent } = fakeWs();
    handleStructuredConnection(ws, REQ, ringManager([REAL_TURN]), undefined, undefined, undefined, undefined, undefined, () => SAVED);
    expect(sent).toEqual([REAL_TURN, { type: 'permission', pending: SAVED }]);
  });

  it('sends nothing more when no question is saved, and a throwing lookup never breaks the replay', () => {
    const a = fakeWs();
    handleStructuredConnection(a.ws, REQ, ringManager([REAL_TURN]), undefined, undefined, undefined, undefined, undefined, () => null);
    expect(a.sent).toEqual([REAL_TURN]);
    const b = fakeWs();
    handleStructuredConnection(b.ws, REQ, ringManager([REAL_TURN]), undefined, undefined, undefined, undefined, undefined, () => { throw new Error('db gone'); });
    expect(b.sent).toEqual([REAL_TURN]);
  });
});


// ---- W2-I: batched replay (`?batch=1`) ----
describe('batched replay', () => {
  afterEach(() => { vi.useRealTimers(); delete process.env.DISPATCH_WS_MAX_BUFFERED_BYTES; delete process.env.DISPATCH_WS_BUFFER_GRACE_MS; vi.restoreAllMocks(); });
  const ring = Array.from({ length: 12 }, (_, i) => ({ type: 'assistant', message: { content: [{ type: 'text', text: `turn ${i}` }] } }));
  const BATCH_REQ = { url: '/api/terminals/t1/structured-ws?tail=200&batch=1' } as any;

  it('batch=1 sends one frame with the same events in order', () => {
    const plain = fakeWs();
    handleStructuredConnection(plain.ws, REQ, { ...ringManager(ring), getPending: () => ({ requestId: 'r1' }) }, undefined, undefined, undefined, undefined, () => 'model-x');
    const batched = fakeWs();
    handleStructuredConnection(batched.ws, BATCH_REQ, { ...ringManager(ring), getPending: () => ({ requestId: 'r1' }) }, undefined, undefined, undefined, undefined, () => 'model-x');
    expect(batched.sent).toHaveLength(1);
    expect(batched.sent[0].type).toBe('replay');
    expect(batched.sent[0].done).toBe(true);
    // The same frames an older client gets one by one: the ring, the model frame, the pending permission.
    expect(batched.sent[0].events).toEqual(plain.sent);
    expect(plain.sent).toHaveLength(14);
  });

  it('no batch parameter keeps the old frames', () => {
    const { ws, sent } = fakeWs();
    handleStructuredConnection(ws, REQ, ringManager(ring));
    expect(sent).toEqual(ring);
    expect(sent.some((f) => f.type === 'replay')).toBe(false);
  });

  it('batch=1 carries the inactive sentinel inside the frame when nothing is renderable', () => {
    const { ws, sent } = fakeWs();
    handleStructuredConnection(ws, BATCH_REQ, ringManager([]));
    expect(sent).toEqual([{ type: 'replay', done: true, events: [{ type: 'system', subtype: 'inactive' }] }]);
  });

  it('a live event during the replay arrives after it', async () => {
    vi.useFakeTimers();
    process.env.DISPATCH_WS_MAX_BUFFERED_BYTES = '1000';
    process.env.DISPATCH_WS_BUFFER_GRACE_MS = '5000';
    const events = Array.from({ length: 20 }, (_, i) => ({ type: 'assistant', message: { content: [{ type: 'text', text: `${i}`.padEnd(200, 'x') }] } }));
    const manager = Object.assign(new EventEmitter(), { getEvents: () => events, getEventsTail: () => events, getPending: () => null }) as any;
    const sent: string[] = [];
    let peak = 0;
    const ws = Object.assign(new EventEmitter(), {
      readyState: 1, bufferedAmount: 0, terminate: vi.fn(), close: vi.fn(),
      send: vi.fn(function (this: any, d: string) { sent.push(d); this.bufferedAmount += d.length; peak = Math.max(peak, this.bufferedAmount); }),
    }) as any;
    handleStructuredConnection(ws as WebSocket, { url: '/api/terminals/t1/structured-ws?batch=1' } as any, manager);
    manager.emit('event', 't1', { type: 'assistant', message: { content: [{ type: 'text', text: 'LIVE-1' }] } });
    manager.emit('event', 't1', { type: 'assistant', message: { content: [{ type: 'text', text: 'LIVE-2' }] } });
    for (let i = 0; i < 400 && !sent.some((m) => m.includes('LIVE-2')); i++) {
      await vi.advanceTimersByTimeAsync(25);
      ws.bufferedAmount = Math.max(0, ws.bufferedAmount - 150);
    }
    const frames = sent.map((m) => JSON.parse(m));
    const replays = frames.filter((f) => f.type === 'replay');
    // A history over half the back-pressure limit goes out as several replay frames, in step with the free space.
    expect(replays.length).toBeGreaterThan(1);
    expect(replays.flatMap((f) => f.events)).toEqual(events);
    expect(replays.map((f) => f.done)).toEqual([...replays.slice(1).map(() => false), true]);
    // Then the live events, in the order they happened, as ordinary frames.
    const tail = frames.slice(replays.length);
    expect(frames.slice(0, replays.length).every((f) => f.type === 'replay')).toBe(true);
    expect(tail.map((f) => f.message.content[0].text)).toEqual(['LIVE-1', 'LIVE-2']);
    expect(peak).toBeLessThanOrEqual(500 + 600);
    expect(ws.terminate).not.toHaveBeenCalled();
    // After the replay a live event goes straight out.
    manager.emit('event', 't1', { type: 'assistant', message: { content: [{ type: 'text', text: 'LIVE-3' }] } });
    expect(sent[sent.length - 1]).toContain('LIVE-3');
  });

  it('batch=1 with a real socket: the frame is compressed on the wire', async () => {
    const http = await import('node:http');
    const { WebSocket: Client } = await import('ws');
    const { createClientWss } = await import('./client-wss.js');
    const big = Array.from({ length: 200 }, (_, i) => ({ type: 'assistant', message: { content: [{ type: 'text', text: `message ${i} says the same words again and again` }] } }));
    const wss = createClientWss(undefined, { deflate: true });
    const server = http.createServer();
    server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (sock) => handleStructuredConnection(sock, req, ringManager(big))));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    async function open(query: string): Promise<{ frames: any[]; wire: number }> {
      const c = new Client(`ws://127.0.0.1:${port}/api/terminals/t1/structured-ws?tail=200${query}`);
      const frames: any[] = [];
      let socket: import('node:net').Socket | undefined;
      c.on('upgrade', (res) => { socket = res.socket; });
      c.on('message', (d) => frames.push(JSON.parse(d.toString())));
      await new Promise((r) => c.on('open', r));
      await new Promise((r) => setTimeout(r, 150));
      const wire = socket?.bytesRead ?? -1;
      c.close();
      return { frames, wire };
    }
    try {
      const old = await open('');
      const now = await open('&batch=1');
      expect(old.frames).toEqual(big);
      expect(now.frames).toHaveLength(1);
      expect(now.frames[0].events).toEqual(big);
      // 200 frames under 1 KB each are sent as they are; one frame is compressed.
      expect(now.wire).toBeLessThan(old.wire / 4);
      console.log(`[w2-i] 200-event replay on the wire: ${old.wire} bytes as 200 frames, ${now.wire} bytes as one batch frame`);
    } finally { server.close(); }
  });
});

// ---- W3-D: the replay from the message journal (`?journal=1`) and the resume cursor (`?after=seq`) ----
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import { MessageJournal } from '../journal/journal.js';
import { JournalRecorder } from '../journal/recorder.js';
import { EventRing } from '../structured/shared/event-ring.js';

describe('replay from the message journal', () => {
  const userEvent = (text: string) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
  const stream = (event: Record<string, unknown>) => ({ type: 'stream_event', event });
  const JOURNAL_REQ = (extra = '') => ({ url: `/api/terminals/t1/structured-ws?tail=200&journal=1${extra}` }) as any;

  /** A thread with a real ring, a recorder and a journal: `turn(n)` runs one finished turn (4 items). */
  function thread() {
    const db = new Database(':memory:');
    initSchema(db);
    const journal = new MessageJournal(db);
    const recorder = new JournalRecorder(journal);
    const ring = new EventRing();
    recorder.attach('t1', ring, { wholeFrames: false });
    const emitter = new EventEmitter();
    const push = (e: unknown) => { ring.push(e); emitter.emit('event', 't1', e); };
    const turn = (n: number) => {
      push(userEvent(`question ${n}`));
      push(stream({ type: 'message_start' }));
      push(stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
      push(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `answer ${n} ` } }));
      push(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'in two deltas' } }));
      push(stream({ type: 'content_block_stop', index: 0 }));
      push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `call-${n}`, name: 'Shell', input: { command: 'ls' } }] } });
      push({ type: 'result', subtype: 'turn', is_error: false, duration_ms: 3 });
    };
    const manager = Object.assign(emitter, {
      getEvents: () => ring.snapshot(), getEventsTail: (_id: string, n: number) => ring.tail(n), getPending: () => null,
      journal: recorder, // the daemon sets it on each manager (journal/wire.ts)
    }) as any;
    return { journal, recorder, ring, manager, push, turn };
  }
  const connect = (t: ReturnType<typeof thread>, req: any, opts: { restOwned?: boolean; settled?: boolean } = {}) => {
    const { ws, sent } = fakeWs();
    handleStructuredConnection(ws, req, t.manager, undefined, () => opts.restOwned === true, () => false, () => opts.settled !== false);
    return sent;
  };

  it('replayed finished items carry seq', () => {
    const t = thread();
    t.turn(1); t.turn(2);
    const sent = connect(t, JOURNAL_REQ());
    expect(sent).toHaveLength(1);
    const frame = sent[0];
    expect(frame).toMatchObject({ type: 'journal', reset: true, after: null, firstSeq: 1, lastSeq: 8, hasMore: false });
    expect(frame.items.map((i: any) => i.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(frame.items.map((i: any) => i.kind)).toEqual(['user', 'assistant', 'tool', 'result', 'user', 'assistant', 'tool', 'result']);
    expect(frame.items[1].payload.message.content).toEqual([{ type: 'text', text: 'answer 1 in two deltas' }]);
    // No delta is replayed: the frame holds finished items only.
    expect(JSON.stringify(sent)).not.toContain('content_block_delta');
  });

  it('an older client (no journal parameter) gets the ring as before, and its finished events carry seq', () => {
    const t = thread();
    t.turn(1);
    const sent = connect(t, REQ);
    expect(sent).toEqual(t.ring.snapshot());
    expect(sent.some((f) => f.type === 'journal')).toBe(false);
    expect(sent.filter((f) => typeof f.seq === 'number').map((f) => f.seq)).toEqual([1, 2, 3, 4]);
  });

  it('a reconnect with afterSeq sends only newer items', () => {
    const t = thread();
    t.turn(1); t.turn(2); t.turn(3);
    const sent = connect(t, JOURNAL_REQ('&after=8'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'journal', reset: false, after: 8, lastSeq: 12 });
    expect(sent[0].items.map((i: any) => i.seq)).toEqual([9, 10, 11, 12]);
  });

  it('a reconnect that has everything gets an empty frame, not the history again', () => {
    const t = thread();
    t.turn(1);
    const sent = connect(t, JOURNAL_REQ('&after=4'));
    expect(sent).toEqual([{ type: 'journal', reset: false, after: 4, items: [], firstSeq: 1, lastSeq: 4, hasMore: false }]);
  });

  it('a cursor ahead of the journal, or one whose next rows were trimmed, gets the newest window again', () => {
    const t = thread();
    t.turn(1); t.turn(2);
    expect(connect(t, JOURNAL_REQ('&after=99'))[0]).toMatchObject({ type: 'journal', reset: true, after: null });
    t.journal.trim('t1', { maxRows: 2 });
    const sent = connect(t, JOURNAL_REQ('&after=3'));
    expect(sent[0]).toMatchObject({ type: 'journal', reset: true, firstSeq: 7, lastSeq: 8 });
    expect(sent[0].items.map((i: any) => i.seq)).toEqual([7, 8]);
  });

  it('the block that streams now follows the frame, and live events follow that', () => {
    const t = thread();
    t.turn(1);
    t.push(userEvent('question 2'));
    t.push(stream({ type: 'message_start' }));
    t.push(stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    t.push(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half ' } }));
    t.push(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'an answer' } }));
    const sent = connect(t, JOURNAL_REQ(), { settled: false });
    expect(sent[0].items.map((i: any) => i.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(sent.slice(1)).toEqual([
      stream({ type: 'message_start' }),
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half an answer' } }),
    ]);
    const stop = stream({ type: 'content_block_stop', index: 0 });
    t.push(stop);
    expect(sent[sent.length - 1]).toEqual({ ...stop, seq: 6 });
  });

  it('a working thread with no open block still shows busy: a message start follows the frame', () => {
    const t = thread();
    t.turn(1);
    t.push(userEvent('question 2'));
    expect(connect(t, JOURNAL_REQ(), { settled: false }).slice(1)).toEqual([stream({ type: 'message_start' })]);
    // A settled thread gets no such frame.
    expect(connect(t, JOURNAL_REQ(), { settled: true })).toHaveLength(1);
  });

  it('a settled thread whose tail would leave the spinner on gets the settle', () => {
    const t = thread();
    t.turn(1);
    t.push({ type: 'assistant', subtype: 'context_fill', message: { role: 'assistant', content: [], usage: { input_tokens: 9 } } });
    const sent = connect(t, JOURNAL_REQ(), { settled: true });
    expect(sent.slice(1)).toEqual([
      { type: 'assistant', message: { role: 'assistant', content: [], usage: { input_tokens: 9 } } },
      { type: 'result', subtype: 'backfill', is_error: false },
    ]);
  });

  it('a thread with an empty journal gets the ring as before', () => {
    const { ws, sent } = fakeWs();
    const db = new Database(':memory:');
    initSchema(db);
    handleStructuredConnection(ws, JOURNAL_REQ(), { ...ringManager([REAL_TURN]), journal: new JournalRecorder(new MessageJournal(db)) });
    expect(sent).toEqual([REAL_TURN]);
    // And a manager with no journal at all.
    const plain = fakeWs();
    handleStructuredConnection(plain.ws, JOURNAL_REQ(), ringManager([REAL_TURN]));
    expect(plain.sent).toEqual([REAL_TURN]);
  });

  it('a thread whose history REST owns (Codex) gets no first window from the journal, but a resume is served', () => {
    const t = thread();
    t.turn(1); t.turn(2);
    expect(connect(t, JOURNAL_REQ(), { restOwned: true })).toEqual([{ type: 'system', subtype: 'inactive' }]);
    const resumed = connect(t, JOURNAL_REQ('&after=4'), { restOwned: true });
    expect(resumed).toHaveLength(1);
    expect(resumed[0].items.map((i: any) => i.seq)).toEqual([5, 6, 7, 8]);
  });

  it('a journal source that throws falls back to the ring', () => {
    const { ws, sent } = fakeWs();
    handleStructuredConnection(ws, JOURNAL_REQ(), { ...ringManager([REAL_TURN]), journal: { replay: () => { throw new Error('db gone'); } } });
    expect(sent).toEqual([REAL_TURN]);
  });

  it('batch=1 carries the journal frame inside the replay frame, with the model and the pending question after it', () => {
    const t = thread();
    t.turn(1);
    const { ws, sent } = fakeWs();
    handleStructuredConnection(ws, JOURNAL_REQ('&batch=1'), { ...t.manager, on: () => {}, off: () => {}, getPending: () => ({ requestId: 'r1' }) }, undefined, undefined, undefined, undefined, () => 'model-x');
    expect(sent).toHaveLength(1);
    expect(sent[0].events.map((e: any) => e.type)).toEqual(['journal', 'system', 'permission']);
  });

  it('a resume with the cursor sends far fewer bytes than the replay it replaces', () => {
    const t = thread();
    for (let n = 1; n <= 50; n++) t.turn(n);
    const bytes = (frames: unknown[]) => frames.reduce((sum: number, f) => sum + Buffer.byteLength(JSON.stringify(f)), 0);
    const ringReplay = bytes(connect(t, REQ));                       // before W3-D: the ring tail on every reconnect
    const journalReplay = bytes(connect(t, JOURNAL_REQ()));          // a first open from the journal
    const lastSeen = t.journal.lastSeq('t1') - 4;                     // the client missed one turn
    const resume = bytes(connect(t, JOURNAL_REQ(`&after=${lastSeen}`)));
    console.log(`[w3-d] reconnect of a 50-turn thread: ring tail ${ringReplay} bytes, journal window ${journalReplay} bytes, resume with the cursor ${resume} bytes`);
    expect(resume).toBeLessThan(ringReplay / 10);
    expect(resume).toBeLessThan(journalReplay / 10);
  });
});
