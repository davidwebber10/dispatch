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
});

