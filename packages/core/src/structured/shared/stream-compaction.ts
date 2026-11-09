// packages/core/src/structured/shared/stream-compaction.ts
//
// What the replay ring drops once a streamed message is complete. A long reply is hundreds of
// `stream_event` deltas; a viewer that connects later does not need them one by one.
//
// Two shapes, because the harnesses differ in what they send when a message is done:
//
//   Claude sends each content block again as a whole `assistant` frame. When every block of a
//   message has its whole frame and the message has stopped, the ring drops the message's stream
//   frames (ClaudeStreamCompactor). The `message_start` stays: the chat reducer clears its
//   per-message block map on it, and then adds each whole block it has no streamed copy of
//   (useStructuredChat, "REPLAY-CUT RECOVERY").
//
//   Codex and ACP send no whole `assistant` text frame: the deltas ARE the message. When a block
//   closes, the ring replaces its deltas with ONE delta that holds the whole text
//   (BlockDeltaCoalescer). The replay keeps the same grammar (start, delta, stop), so the reducer
//   renders it the same way.
//
// Both change the ring only. The events that the manager emits to live viewers are not changed.

import type { EventRing } from './event-ring.js';

type Frame = { type?: unknown; event?: any; message?: any; parent_tool_use_id?: unknown };

interface OpenMessage {
  /** The id in the frames (`msg_...`). */
  messageId: string;
  /** The tag on this message's stream frames in the ring. */
  tag: string;
  /** `ring.pushes` when the message started: compaction looks only at the events after it. */
  since: number;
  /** Content blocks that started. */
  blocks: number;
  /** Content blocks that arrived whole. */
  wholes: number;
  stopped: boolean;
}

/** Drops the stream frames of a Claude message once the message is in the ring as whole frames. */
export class ClaudeStreamCompactor {
  /** The open message of each stream: the lead agent ('') and each sub-agent (its parent tool id). */
  private open = new Map<string, OpenMessage>();
  private tags = new WeakMap<object, string>();
  private seq = 0;
  private readonly tagOf = (event: unknown): string | null =>
    (typeof event === 'object' && event !== null ? this.tags.get(event) ?? null : null);

  /** Call with each CLI frame, after it was pushed to `ring`. Returns how many events left the ring. */
  observe(ring: EventRing, frame: unknown): number {
    const f = frame as Frame | null;
    if (!f || typeof f !== 'object') return 0;
    const key = typeof f.parent_tool_use_id === 'string' ? f.parent_tool_use_id : '';
    if (f.type === 'stream_event' && f.event) {
      const se = f.event;
      if (se.type === 'message_start') {
        const messageId = se.message?.id;
        // Not tagged: the message_start stays in the ring (see the file comment).
        if (typeof messageId === 'string' && messageId) this.open.set(key, { messageId, tag: `m${++this.seq}`, since: ring.pushes, blocks: 0, wholes: 0, stopped: false });
        else this.open.delete(key); // no id to match the whole frames on: leave this message alone
        return 0;
      }
      const msg = this.open.get(key);
      if (!msg || msg.stopped) return 0;
      this.tags.set(f, msg.tag);
      if (se.type === 'content_block_start') msg.blocks += 1;
      if (se.type === 'message_stop') { msg.stopped = true; return this.finish(ring, key, msg); }
      return 0;
    }
    if (f.type === 'assistant') {
      const msg = this.open.get(key);
      if (msg && f.message?.id === msg.messageId && Array.isArray(f.message.content)) {
        msg.wholes += f.message.content.length;
        return this.finish(ring, key, msg);
      }
      return 0;
    }
    // A turn end: a message that is still open here was cut off, and keeps its deltas.
    if (f.type === 'result') this.open.clear();
    return 0;
  }

  private finish(ring: EventRing, key: string, msg: OpenMessage): number {
    if (!msg.stopped || msg.blocks === 0 || msg.wholes < msg.blocks) return 0;
    this.open.delete(key);
    return ring.compact(this.tagOf, msg.tag, undefined, msg.since);
  }
}

interface OpenBlock {
  tag: string;
  /** `ring.pushes` when the block started: compaction looks only at the events after it. */
  since: number;
  /** The delta type and its text field, from the first delta. */
  deltaType?: string;
  field?: string;
  text: string;
  deltas: number;
  /** A block whose deltas are not all of one text kind is left alone. */
  mixed: boolean;
}

const DELTA_FIELD: Record<string, string> = { text_delta: 'text', thinking_delta: 'thinking', input_json_delta: 'partial_json' };

/** Replaces the deltas of a closed content block with one delta that holds the whole text. */
export class BlockDeltaCoalescer {
  private blocks = new Map<number, OpenBlock>();
  private tags = new WeakMap<object, string>();
  private seq = 0;
  private readonly tagOf = (event: unknown): string | null =>
    (typeof event === 'object' && event !== null ? this.tags.get(event) ?? null : null);

  /** Call with each event, after it was pushed to `ring`. Returns how many events left the ring. */
  observe(ring: EventRing, event: unknown): number {
    const f = event as Frame | null;
    if (!f || typeof f !== 'object') return 0;
    // A turn end closes every block: Codex never sends a stop for a reasoning block.
    if (f.type === 'result') return this.closeAll(ring);
    if (f.type !== 'stream_event' || !f.event) return 0;
    const se = f.event;
    if (se.type === 'message_start') return this.closeAll(ring); // block indexes start again
    const index: unknown = se.index;
    if (typeof index !== 'number') return 0;
    if (se.type === 'content_block_start') {
      const removed = this.close(ring, index);
      this.blocks.set(index, { tag: `b${++this.seq}`, since: ring.pushes, text: '', deltas: 0, mixed: false });
      return removed;
    }
    if (se.type === 'content_block_delta') {
      const block = this.blocks.get(index);
      if (!block) return 0;
      const type: unknown = se.delta?.type;
      const field = typeof type === 'string' ? DELTA_FIELD[type] : undefined;
      const piece = field ? se.delta[field] : undefined;
      if (!field || typeof piece !== 'string' || (block.deltaType !== undefined && block.deltaType !== type)) { block.mixed = true; return 0; }
      block.deltaType = type as string;
      block.field = field;
      block.text += piece;
      block.deltas += 1;
      this.tags.set(f, block.tag);
      return 0;
    }
    if (se.type === 'content_block_stop') return this.close(ring, index);
    return 0;
  }

  private closeAll(ring: EventRing): number {
    let removed = 0;
    for (const index of [...this.blocks.keys()]) removed += this.close(ring, index);
    return removed;
  }

  private close(ring: EventRing, index: number): number {
    const block = this.blocks.get(index);
    if (!block) return 0;
    this.blocks.delete(index);
    if (block.mixed || block.deltas < 2 || !block.deltaType || !block.field) return 0;
    const merged = { type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: block.deltaType, [block.field]: block.text } } };
    // One event takes the place of `deltas` events.
    return ring.compact(this.tagOf, block.tag, merged, block.since) - 1;
  }
}
