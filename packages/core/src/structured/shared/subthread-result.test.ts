// Final review N8: a sub-thread's `result` (it carries parent_tool_use_id) is never the thread's turn end.
// The ring compaction keeps the main agent's and a sub-thread's blocks apart (same index, other stream).
import { describe, it, expect } from 'vitest';
import { EventRing } from './event-ring.js';
import { BlockDeltaCoalescer, ClaudeStreamCompactor } from './stream-compaction.js';

const se = (event: Record<string, unknown>, parent?: string) => ({ type: 'stream_event', event, ...(parent ? { parent_tool_use_id: parent } : {}) });
const delta = (index: number, text: string, parent?: string) => se({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } }, parent);

function texts(ring: EventRing): Array<[string, string]> {
  return (ring.snapshot() as any[]).filter((e) => e.type === 'stream_event' && e.event?.type === 'content_block_delta')
    .map((e) => [e.parent_tool_use_id ?? '', e.event.delta.text]);
}

describe('BlockDeltaCoalescer', () => {
  it('blocks of the main agent and of a sub-thread at the same index are merged apart; a sub-thread result closes only its own', () => {
    const ring = new EventRing();
    const c = new BlockDeltaCoalescer();
    const push = (e: unknown) => { ring.push(e); c.observe(ring, e); };
    push(se({ type: 'content_block_start', index: 0 }));
    push(se({ type: 'content_block_start', index: 0 }, 'sub-1'));
    push(delta(0, 'Main '));
    push(delta(0, 'Sub '));
    push(delta(0, 'one', 'sub-1'));
    push(delta(0, 'two', 'sub-1'));
    push(delta(0, 'answer.'));
    // The sub-thread ends: its blocks close; the main block is still open (its deltas are untouched).
    push({ type: 'result', subtype: 'success', parent_tool_use_id: 'sub-1' });
    expect(texts(ring)).toEqual([['', 'Main '], ['', 'Sub '], ['sub-1', 'onetwo'], ['', 'answer.']]);
    push(se({ type: 'content_block_stop', index: 0 }));
    expect(texts(ring)).toEqual([['', 'Main Sub answer.'], ['sub-1', 'onetwo']]);
  });
});

describe('ClaudeStreamCompactor', () => {
  it("a sub-thread result does not close the main agent's open message", () => {
    const ring = new EventRing();
    const c = new ClaudeStreamCompactor();
    const push = (e: unknown) => { ring.push(e); c.observe(ring, e); };
    push(se({ type: 'message_start', message: { id: 'm-main' } }));
    push(se({ type: 'content_block_start', index: 0 }));
    push({ type: 'result', subtype: 'success', parent_tool_use_id: 'sub-1' });
    push(se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }));
    push(se({ type: 'content_block_stop', index: 0 }));
    push(se({ type: 'message_stop' }));
    push({ type: 'assistant', message: { id: 'm-main', content: [{ type: 'text', text: 'x' }] } });
    // The whole frame replaced the main message's stream events: it was still open after the sub-thread's result.
    expect((ring.snapshot() as any[]).some((e) => e.type === 'stream_event' && e.event?.type === 'content_block_delta')).toBe(false);
  });
});
