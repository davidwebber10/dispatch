// hasRenderableEvents mirrors the client fold (useStructuredChat's onEvent): an event is
// renderable iff it would produce a visible conversation item. The `system/inactive`
// REST-hydration sentinel fires when the ring holds NO renderable events — covering the
// empty ring AND the 0b8e106 deadlock ring (system/init + system/status + a stale result),
// which is non-empty yet renders nothing.
import { describe, it, expect } from 'vitest';
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
