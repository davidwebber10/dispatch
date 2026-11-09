// packages/core/src/structured/shared/event-ring.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventRing } from './event-ring.js';
import { ClaudeStreamCompactor, BlockDeltaCoalescer } from './stream-compaction.js';

afterEach(() => { vi.useRealTimers(); });

describe('EventRing', () => {
  it('drops the oldest events over the count limit', () => {
    const ring = new EventRing({ maxEvents: 3 });
    for (let i = 1; i <= 5; i++) ring.push({ n: i });
    expect(ring.snapshot()).toEqual([{ n: 3 }, { n: 4 }, { n: 5 }]);
    expect(ring.length).toBe(3);
  });

  it('drops the oldest events over the byte limit', () => {
    const big = (n: number) => ({ n, pad: 'x'.repeat(100) });
    const one = JSON.stringify(big(1)).length;
    const ring = new EventRing({ maxBytes: one * 3 });
    for (let i = 1; i <= 5; i++) ring.push(big(i));
    expect((ring.snapshot() as { n: number }[]).map((e) => e.n)).toEqual([3, 4, 5]);
    expect(ring.bytes).toBe(one * 3);
    expect(ring.bytes).toBeLessThanOrEqual(one * 3);
  });

  it('keeps the newest event even when it alone is over the byte limit', () => {
    const ring = new EventRing({ maxBytes: 10 });
    ring.push({ a: 1 });
    ring.push({ pad: 'x'.repeat(500) });
    expect(ring.length).toBe(1);
    expect((ring.snapshot()[0] as { pad: string }).pad).toHaveLength(500);
  });

  it('the defaults are 5,000 events and 8 MB', () => {
    const ring = new EventRing();
    for (let i = 0; i < 5005; i++) ring.push({ i });
    expect(ring.length).toBe(5000);
    const chunk = { pad: 'x'.repeat(1024 * 1024) };
    const big = new EventRing();
    for (let i = 0; i < 12; i++) big.push({ ...chunk, i });
    expect(big.bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(big.length).toBe(7);
  });

  it('seed applies both limits and keeps the newest history', () => {
    const ring = new EventRing({ maxEvents: 2 });
    ring.seed([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(ring.snapshot()).toEqual([{ n: 2 }, { n: 3 }]);
    expect(ring.bytes).toBe(JSON.stringify({ n: 2 }).length * 2);
  });

  it('snapshot order equals push order', () => {
    const ring = new EventRing();
    ring.seed(['s1', 's2']);
    ring.push('a'); ring.push('b'); ring.push('c');
    expect(ring.snapshot()).toEqual(['s1', 's2', 'a', 'b', 'c']);
    // A snapshot is a copy: a caller cannot change the ring through it.
    ring.snapshot().length = 0;
    expect(ring.length).toBe(5);
    expect(ring.tail(2)).toEqual(['b', 'c']);
    expect(ring.tail(99)).toEqual(['s1', 's2', 'a', 'b', 'c']);
  });

  it('lastPushAt moves on push', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const ring = new EventRing();
    expect(ring.lastPushAt).toBeUndefined();
    ring.seed([{ old: true }]);
    expect(ring.lastPushAt).toBeUndefined(); // history is not a sign of life
    ring.push({ a: 1 });
    expect(ring.lastPushAt).toBe(1_000);
    vi.setSystemTime(2_500);
    ring.push({ a: 2 }, { quiet: true }); // an event the daemon wrote itself: no frame from the CLI
    expect(ring.lastPushAt).toBe(1_000);
    ring.push({ a: 3 });
    expect(ring.lastPushAt).toBe(2_500);
  });

  it('onCommit sees each pushed event, and no seeded event', () => {
    const ring = new EventRing();
    const seen: unknown[] = [];
    ring.onCommit = (e) => seen.push(e);
    ring.seed([{ old: 1 }]);
    ring.push({ a: 1 });
    ring.push({ a: 2 }, { quiet: true });
    expect(seen).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('compact removes the deltas of a finished message and keeps the message', () => {
    const ring = new EventRing();
    const delta = (id: string, text: string) => ({ kind: 'delta', id, text });
    ring.push({ kind: 'user', text: 'hi' });
    ring.push(delta('m1', 'Hel'));
    ring.push(delta('m2', 'other'));
    ring.push(delta('m1', 'lo'));
    ring.push({ kind: 'message', id: 'm1', text: 'Hello' });
    const before = ring.bytes;
    const removed = ring.compact((e) => ((e as { kind?: string }).kind === 'delta' ? (e as { id: string }).id : null), 'm1');
    expect(removed).toBe(2);
    expect(ring.snapshot()).toEqual([{ kind: 'user', text: 'hi' }, delta('m2', 'other'), { kind: 'message', id: 'm1', text: 'Hello' }]);
    expect(ring.bytes).toBe(before - JSON.stringify(delta('m1', 'Hel')).length - JSON.stringify(delta('m1', 'lo')).length);
    expect(ring.bytes).toBe(ring.snapshot().reduce((n: number, e) => n + JSON.stringify(e).length, 0));
  });

  it('compact with a replacement puts it where the first delta was', () => {
    const ring = new EventRing();
    ring.push('start'); ring.push({ d: 'a' }); ring.push({ d: 'b' }); ring.push('stop');
    const removed = ring.compact((e) => (typeof e === 'object' ? 'blk' : null), 'blk', { d: 'ab' });
    expect(removed).toBe(2);
    expect(ring.snapshot()).toEqual(['start', { d: 'ab' }, 'stop']);
    expect(ring.bytes).toBe(ring.snapshot().reduce((n: number, e) => n + JSON.stringify(e).length, 0));
  });

  it('compact that finds nothing changes nothing', () => {
    const ring = new EventRing();
    ring.push('a');
    expect(ring.compact(() => null, 'x', { never: true })).toBe(0);
    expect(ring.snapshot()).toEqual(['a']);
  });
});

// The frames of one streamed Claude message, as Claude Code 2.x writes them with partial messages.
function claudeMessage(id: string, blocks: { type: 'text' | 'tool_use'; pieces: string[] }[], parent: string | null = null) {
  const se = (event: unknown) => ({ type: 'stream_event', event, parent_tool_use_id: parent, session_id: 's', uuid: `u-${Math.random()}` });
  const out: any[] = [se({ type: 'message_start', message: { id, role: 'assistant', content: [] } })];
  blocks.forEach((b, index) => {
    out.push(se({ type: 'content_block_start', index, content_block: b.type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: `tu-${id}-${index}`, name: 'Bash', input: {} } }));
    for (const p of b.pieces) out.push(se({ type: 'content_block_delta', index, delta: b.type === 'text' ? { type: 'text_delta', text: p } : { type: 'input_json_delta', partial_json: p } }));
    const block = b.type === 'text' ? { type: 'text', text: b.pieces.join('') } : { type: 'tool_use', id: `tu-${id}-${index}`, name: 'Bash', input: JSON.parse(b.pieces.join('')) };
    out.push({ type: 'assistant', message: { id, role: 'assistant', content: [block] }, parent_tool_use_id: parent, uuid: `a-${id}-${index}` });
    out.push(se({ type: 'content_block_stop', index }));
  });
  out.push(se({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
  out.push(se({ type: 'message_stop' }));
  return out;
}
const kinds = (ring: EventRing) => (ring.snapshot() as any[]).map((e) => (e.type === 'stream_event' ? e.event.type : e.type));

describe('ClaudeStreamCompactor', () => {
  it('a finished message keeps its message_start and its whole frames; the stream frames go', () => {
    const ring = new EventRing();
    const compactor = new ClaudeStreamCompactor();
    const frames = claudeMessage('msg_1', [{ type: 'text', pieces: ['Hel', 'lo ', 'there'] }, { type: 'tool_use', pieces: ['{"command":', '"ls"}'] }]);
    for (const f of frames) { ring.push(f); compactor.observe(ring, f); }
    expect(kinds(ring)).toEqual(['message_start', 'assistant', 'assistant']);
    const wholes = (ring.snapshot() as any[]).filter((e) => e.type === 'assistant');
    expect(wholes[0].message.content[0].text).toBe('Hello there');
    expect(wholes[1].message.content[0].input).toEqual({ command: 'ls' });
  });

  it('a message still in flight is not touched', () => {
    const ring = new EventRing();
    const compactor = new ClaudeStreamCompactor();
    const frames = claudeMessage('msg_1', [{ type: 'text', pieces: ['a', 'b'] }, { type: 'text', pieces: ['c', 'd'] }]);
    const inFlight = frames.slice(0, 7); // block 0 done (its whole frame is in), block 1 streams
    for (const f of inFlight) { ring.push(f); compactor.observe(ring, f); }
    expect(kinds(ring)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'assistant', 'content_block_stop', 'content_block_start']);
  });

  it('a message whose whole frames never came (an interrupt) keeps its deltas', () => {
    const ring = new EventRing();
    const compactor = new ClaudeStreamCompactor();
    const frames = claudeMessage('msg_1', [{ type: 'text', pieces: ['a', 'b'] }]).filter((f) => f.type !== 'assistant');
    for (const f of frames) { ring.push(f); compactor.observe(ring, f); }
    expect(kinds(ring)).toContain('content_block_delta');
    expect(ring.length).toBe(frames.length);
  });

  it('the whole frame may come after message_stop', () => {
    const ring = new EventRing();
    const compactor = new ClaudeStreamCompactor();
    const frames = claudeMessage('msg_1', [{ type: 'text', pieces: ['a', 'b'] }]);
    const whole = frames.find((f) => f.type === 'assistant');
    const late = [...frames.filter((f) => f.type !== 'assistant'), whole];
    for (const f of late) { ring.push(f); compactor.observe(ring, f); }
    expect(kinds(ring)).toEqual(['message_start', 'assistant']);
  });

  it('a sub-agent stream and the lead stream are compacted apart', () => {
    const ring = new EventRing();
    const compactor = new ClaudeStreamCompactor();
    const lead = claudeMessage('msg_lead', [{ type: 'text', pieces: ['l1', 'l2'] }]);
    const sub = claudeMessage('msg_sub', [{ type: 'text', pieces: ['s1', 's2'] }], 'toolu_task');
    // The sub-agent finishes while the lead message is still open.
    const order = [...lead.slice(0, 3), ...sub, ...lead.slice(3)];
    let afterSub: string[] = [];
    order.forEach((f, i) => {
      ring.push(f); compactor.observe(ring, f);
      if (i === 2 + sub.length) afterSub = kinds(ring);
    });
    expect(afterSub).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'message_start', 'assistant']);
    expect(kinds(ring)).toEqual(['message_start', 'message_start', 'assistant', 'assistant']);
  });

  it('a message_start without a message id is left alone', () => {
    const ring = new EventRing();
    const compactor = new ClaudeStreamCompactor();
    const frames = [
      { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } },
      { type: 'stream_event', event: { type: 'message_stop' } },
    ];
    for (const f of frames) { ring.push(f); compactor.observe(ring, f); }
    expect(ring.length).toBe(frames.length);
  });
});

describe('BlockDeltaCoalescer', () => {
  const se = (event: unknown) => ({ type: 'stream_event', event });
  const text = (index: number, t: string) => se({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } });
  const thinking = (index: number, t: string) => se({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: t } });
  const start = (index: number, type: 'text' | 'thinking') => se({ type: 'content_block_start', index, content_block: type === 'text' ? { type, text: '' } : { type, thinking: '' } });

  it('a closed block keeps its start and stop and holds one delta with the whole text', () => {
    const ring = new EventRing();
    const c = new BlockDeltaCoalescer();
    const frames = [se({ type: 'message_start' }), start(0, 'text'), text(0, 'Hel'), text(0, 'lo '), text(0, 'there'), se({ type: 'content_block_stop', index: 0 })];
    for (const f of frames) { ring.push(f); c.observe(ring, f); }
    expect(ring.snapshot()).toEqual([se({ type: 'message_start' }), start(0, 'text'), text(0, 'Hello there'), se({ type: 'content_block_stop', index: 0 })]);
  });

  it('an open block is not touched until it closes; a turn end closes every block', () => {
    const ring = new EventRing();
    const c = new BlockDeltaCoalescer();
    const frames = [se({ type: 'message_start' }), start(0, 'thinking'), thinking(0, 'a'), thinking(0, 'b'), start(1, 'text'), text(1, 'x'), text(1, 'y')];
    for (const f of frames) { ring.push(f); c.observe(ring, f); }
    expect(ring.length).toBe(frames.length);
    const result = { type: 'result', subtype: 'codex_turn' };
    ring.push(result); c.observe(ring, result);
    expect(ring.snapshot()).toEqual([se({ type: 'message_start' }), start(0, 'thinking'), thinking(0, 'ab'), start(1, 'text'), text(1, 'xy'), result]);
  });

  it('two messages that use the same block index are kept apart', () => {
    const ring = new EventRing();
    const c = new BlockDeltaCoalescer();
    const one = [se({ type: 'message_start' }), start(0, 'text'), text(0, 'a'), text(0, 'b'), se({ type: 'content_block_stop', index: 0 })];
    const two = [se({ type: 'message_start' }), start(0, 'text'), text(0, 'c'), text(0, 'd'), se({ type: 'content_block_stop', index: 0 })];
    for (const f of [...one, ...two]) { ring.push(f); c.observe(ring, f); }
    const deltas = (ring.snapshot() as any[]).filter((e) => e.event?.type === 'content_block_delta').map((e) => e.event.delta.text);
    expect(deltas).toEqual(['ab', 'cd']);
  });

  it('a stop that carries the final text (Codex) stays as it is', () => {
    const ring = new EventRing();
    const c = new BlockDeltaCoalescer();
    const stop = se({ type: 'content_block_stop', index: 0, final_text: 'Hello' });
    for (const f of [se({ type: 'message_start' }), start(0, 'text'), text(0, 'Hel'), text(0, 'lo'), stop]) { ring.push(f); c.observe(ring, f); }
    expect(ring.snapshot()).toEqual([se({ type: 'message_start' }), start(0, 'text'), text(0, 'Hello'), stop]);
  });

  it('a block with one delta is left as it is', () => {
    const ring = new EventRing();
    const c = new BlockDeltaCoalescer();
    const frames = [se({ type: 'message_start' }), start(0, 'text'), text(0, 'only'), se({ type: 'content_block_stop', index: 0 })];
    for (const f of frames) { ring.push(f); c.observe(ring, f); }
    expect(ring.snapshot()).toEqual(frames);
    expect(ring.snapshot()[2]).toBe(frames[2]);
  });
});
