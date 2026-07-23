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
