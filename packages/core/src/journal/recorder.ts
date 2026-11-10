// packages/core/src/journal/recorder.ts
//
// Writes the message journal from the events of a structured session (engineering program W3-D).
//
// Each manager (Claude, Codex, ACP) gives the replay ring of a session to `JournalRecorder.attach`.
// The recorder takes the ring's `onCommit` hook (W2-D), so it sees each event in the moment the
// manager pushes it, before the manager emits it to the viewers. It folds the events into FINISHED
// items and writes each item once:
//
//   - a `user` event (the daemon's echo of a message, or a tool result),
//   - a whole `assistant` event (Claude sends each content block again as a whole frame; Codex and
//     ACP send a tool call this way),
//   - a streamed block that closed (Codex and ACP send no whole frame for prose: the recorder adds
//     the deltas up and writes one whole frame at the block's stop),
//   - a `result` (the footer of a turn),
//   - a notice (a model switch, a refused setting, a start failure).
//
// Stream deltas are never written. The event that FINISHED an item gets the item's `seq` set on
// it, so the event that the manager emits next, and the same event in the ring, carry the sequence.
//
// What is not finished (a block that still streams) stays in memory here: `openEvents` gives it to
// a viewer that connects in the middle of a message.
//
// A journal failure never stops a session: `commit` logs once and goes on.

import { classifyUserText } from '../conversation/task-notification.js';
import type { JournalKind, MessageJournal } from './journal.js';
import { createJournalReplay, type JournalReplay, type JournalReplayOptions, type JournalReplaySource } from './replay.js';

type Frame = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- an untyped wire event

export interface AttachOptions {
  /**
   * True for a harness that sends each streamed block again as a whole `assistant` frame (Claude):
   * the whole frame is the item, and a streamed block is written from its deltas only when its
   * whole frame never came (the message was cut off). False for Codex and ACP: the deltas are the
   * message, and a block is written at its stop.
   */
  wholeFrames: boolean;
  /** The history that the manager seeds the ring with at a resume (the Claude transcript backfill). */
  seeds?: unknown[];
  /** True when the agent will replay the session's history (an ACP resume). See ThreadRecorder.beginReplay. */
  expectReplay?: boolean;
}

interface OpenBlock {
  parent: string;
  index: number;
  type: 'text' | 'thinking' | 'tool_use';
  text: string;
  toolId?: string;
  toolName?: string;
}

interface StreamState { messageId?: string; wholes: number }

/** The ring's hook. EventRing has it; a test can pass any object with the field. */
export interface CommitSource { onCommit?: (event: unknown) => void }

function isFrame(v: unknown): v is Frame { return typeof v === 'object' && v !== null && !Array.isArray(v); }

function streamFrame(event: Frame, parent: string): Frame {
  return parent ? { type: 'stream_event', event, parent_tool_use_id: parent } : { type: 'stream_event', event };
}

/** The words of an event, for the match of a daemon echo with its transcript line (see importSeeds). */
function fingerprint(event: unknown): string {
  if (!isFrame(event)) return '';
  const content = event.message?.content;
  const parts: string[] = [];
  if (typeof content === 'string') parts.push(content);
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (!isFrame(b)) continue;
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      else if (b.type === 'thinking' && typeof b.thinking === 'string') parts.push(b.thinking);
      else if (b.type === 'tool_use') parts.push(`tool_use:${String(b.id)}`);
      else if (b.type === 'tool_result') parts.push(`tool_result:${String(b.tool_use_id)}`);
      else parts.push(String(b.type));
    }
  }
  return `${String(event.type)}|${parts.join('\n').replace(/\s+/g, ' ').trim()}`;
}

/** The recorder of one live session. */
export class ThreadRecorder {
  private blocks = new Map<string, OpenBlock>();
  private streams = new Map<string, StreamState>();
  private replaying = false;
  private importing = false;
  private warned = false;
  private usage: Frame | null = null;
  private auth: unknown = null;
  private compacting: unknown = null;

  /** Live events held until the replayed history is in (see loadEnded). */
  private held: unknown[] = [];
  private awaitingReplay = false;

  constructor(private readonly journal: MessageJournal, private readonly terminalId: string, private readonly wholeFrames: boolean, expectReplay = false) {
    if (!expectReplay) return;
    this.awaitingReplay = true;
    // Decided now, before any event of this session: an echo that lands before the replay must not
    // make a journal that was empty look like one that has the history.
    try { this.importing = this.journal.lastSeq(this.terminalId) === 0; } catch (err) { this.warn(err); }
  }

  /** The ring's `onCommit`. Never throws. */
  commit(event: unknown): void {
    try { this.fold(event); } catch (err) { this.warn(err); }
  }

  /**
   * The agent replays the history of the session (ACP `session/load`): the events between
   * `beginReplay` and `endReplay` come from a replayed frame. They are the history that the journal
   * has already, so they are ignored. A thread whose journal was empty at the spawn (it is from
   * before the journal) takes them once: that is how its history gets in.
   */
  beginReplay(): void { this.replaying = true; }
  endReplay(): void { this.replaying = false; }

  /**
   * The load of a resumed session ended. A live event that came while the history was still on its
   * way (the echo of a message sent right after the resume) was held, so the history is first: it
   * is written now.
   */
  loadEnded(): void {
    this.awaitingReplay = false;
    const held = this.held;
    this.held = [];
    try {
      if (this.importing) this.flush();
      this.importing = false;
      for (const event of held) this.fold(event);
    } catch (err) { this.warn(err); }
  }

  /**
   * Compare the history that a resume read from the transcript with the journal, and add what the
   * journal lacks. The transcript is the durable record of a Claude thread; the journal lacks an
   * item when the thread ran outside the structured transport (in the CLI), or is from before the
   * journal. The newest seed that the journal has is the join: the seeds after it are added.
   * With no join and a journal that is not empty, a gap mark goes first (the journal may lack
   * items between its rows and the seeds; a page stops at the mark).
   */
  importSeeds(seeds: unknown[]): void {
    try {
      const frames = seeds.filter((s): s is Frame => isFrame(s) && (s.type === 'user' || s.type === 'assistant'));
      if (!frames.length) return;
      if (this.journal.lastSeq(this.terminalId) === 0) { for (const f of frames) this.fold(f); return; }
      let join = -1;
      let joinSeq = 0;
      for (let i = frames.length - 1; i >= 0 && join < 0; i--) {
        const uuid = frames[i].uuid;
        if (typeof uuid !== 'string' || !uuid) continue;
        const seq = this.journal.seqOfNative(this.terminalId, uuid);
        if (seq) { join = i; joinSeq = seq; }
      }
      if (join < 0) {
        this.journal.markGap(this.terminalId);
        for (const f of frames) this.fold(f);
        return;
      }
      const missing = frames.slice(join + 1);
      if (!missing.length) return;
      // Rows after the join with no native id: the daemon's own echo of a message, or the text of a
      // message that was cut off. The transcript line of the same item takes the row.
      const anonymous = this.journal.page(this.terminalId, { afterSeq: joinSeq, limit: 500 }).items.filter((r) => !r.nativeId);
      const used = new Set<number>();
      for (const f of missing) {
        const uuid = f.uuid;
        if (typeof uuid !== 'string' || !uuid) continue; // no identity: it could be added again at each resume
        const want = fingerprint(f);
        const row = anonymous.find((r) => !used.has(r.seq) && fingerprint(r.payload) === want);
        if (row && isFrame(row.payload)) {
          used.add(row.seq);
          if (this.journal.setNative(this.terminalId, row.seq, uuid, { ...row.payload, uuid })) { f.seq = row.seq; continue; }
        }
        this.fold(f);
      }
    } catch (err) { this.warn(err); }
  }

  /** The session ended or is replaced: what streamed and was not finished is written as it is. */
  close(): void {
    try { this.flush(); } catch (err) { this.warn(err); }
  }

  /**
   * The blocks that stream now, as events a client folds: a message start, then for each block
   * its start and one delta with the text so far. Empty when nothing is open.
   */
  openEvents(): unknown[] {
    if (!this.blocks.size) return [];
    const out: unknown[] = [streamFrame({ type: 'message_start' }, '')];
    for (const b of this.blocks.values()) {
      const content_block = b.type === 'text' ? { type: 'text', text: '' }
        : b.type === 'thinking' ? { type: 'thinking', thinking: '' }
          : { type: 'tool_use', id: b.toolId, name: b.toolName, input: {} };
      out.push(streamFrame({ type: 'content_block_start', index: b.index, content_block }, b.parent));
      if (!b.text) continue;
      const delta = b.type === 'text' ? { type: 'text_delta', text: b.text }
        : b.type === 'thinking' ? { type: 'thinking_delta', thinking: b.text }
          : { type: 'input_json_delta', partial_json: b.text };
      out.push(streamFrame({ type: 'content_block_delta', index: b.index, delta }, b.parent));
    }
    return out;
  }

  /** The state a viewer needs and no journal item holds: the last context usage, a standing sign-in notice, a running compaction. */
  stateEvents(): unknown[] {
    return [this.usage, this.auth, this.compacting].filter((e) => e !== null);
  }

  // --- the fold ----------------------------------------------------------------------------------

  private fold(event: unknown): void {
    if (!isFrame(event)) return;
    if (this.replaying) { if (!this.importing) return; }
    else if (this.awaitingReplay && this.importing) { this.held.push(event); return; }
    switch (event.type) {
      case 'user': this.user(event); return;
      case 'assistant': this.assistant(event); return;
      case 'stream_event': this.stream(event); return;
      case 'result': this.result(event); return;
      case 'system': this.system(event); return;
      default: return;
    }
  }

  private user(e: Frame): void {
    // Injected context is not the human's turn and no client renders it (see the chat fold).
    if (e.isSynthetic || e.isMeta || !isFrame(e.message)) return;
    const content = e.message.content;
    const uuid = typeof e.uuid === 'string' && e.uuid ? e.uuid : undefined;
    const texts: string[] = [];
    let results = 0;
    let other = 0;
    let firstResultId: unknown;
    if (typeof content === 'string') texts.push(content);
    else if (Array.isArray(content)) {
      for (const b of content) {
        if (!isFrame(b)) continue;
        if (b.type === 'tool_result') { if (!results) firstResultId = b.tool_use_id; results += 1; }
        else if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
        else if (b.type === 'image') other += 1;
      }
    } else return;
    if (results) {
      const native = uuid ?? (results === 1 && typeof firstResultId === 'string' ? `tr:${firstResultId}` : undefined);
      this.write('tool', native, e, e);
      return;
    }
    const classes = texts.filter((t) => t.trim()).map((t) => classifyUserText(t).kind);
    const shown = classes.filter((k) => k !== 'drop');
    if (!shown.length && !other) return; // nothing a client renders
    const kind: JournalKind = shown.includes('user') || other ? 'user' : 'notice';
    this.write(kind, uuid, e, e);
  }

  private assistant(e: Frame): void {
    const content = e.message?.content;
    if (!Array.isArray(content)) return;
    const parent = typeof e.parent_tool_use_id === 'string' ? e.parent_tool_use_id : '';
    if (!parent && isFrame(e.message.usage)) {
      this.usage = {
        type: 'assistant',
        message: { role: 'assistant', content: [], usage: e.message.usage, ...(typeof e.message.model === 'string' ? { model: e.message.model } : {}) },
        ...(typeof e.context_window === 'number' ? { context_window: e.context_window } : {}),
      };
    }
    // The whole frames of a message cover its streamed blocks, in order: those are not written from their deltas.
    const stream = this.streams.get(parent);
    if (this.wholeFrames && stream?.messageId && e.message.id === stream.messageId) {
      for (let i = 0; i < content.length; i++) this.blocks.delete(`${parent}|${stream.wholes + i}`);
      stream.wholes += content.length;
    }
    let tools = 0;
    let shown = 0;
    let firstToolId: unknown;
    for (const b of content) {
      if (!isFrame(b)) continue;
      if (b.type === 'tool_use') { if (!tools) firstToolId = b.id; tools += 1; shown += 1; }
      else if (b.type === 'thinking' || b.type === 'image') shown += 1;
      else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) shown += 1;
    }
    if (!shown) return; // a usage frame, or blank text
    const uuid = typeof e.uuid === 'string' && e.uuid ? e.uuid : undefined;
    const native = uuid ?? (tools === 1 && content.length === 1 && typeof firstToolId === 'string' ? `tu:${firstToolId}` : undefined);
    this.write(tools === shown ? 'tool' : 'assistant', native, e, e);
  }

  private stream(e: Frame): void {
    const se = e.event;
    if (!isFrame(se)) return;
    const parent = typeof e.parent_tool_use_id === 'string' ? e.parent_tool_use_id : '';
    if (se.type === 'message_start') {
      this.flush(parent); // what the last message of this stream left open
      const messageId = se.message?.id;
      this.streams.set(parent, { messageId: typeof messageId === 'string' && messageId ? messageId : undefined, wholes: 0 });
      return;
    }
    const index: unknown = se.index;
    if (typeof index !== 'number') return;
    const key = `${parent}|${index}`;
    if (se.type === 'content_block_start') {
      // With whole frames and no message id there is nothing to match the whole frames on: the
      // blocks of that message are left to their whole frames.
      if (this.wholeFrames && !this.streams.get(parent)?.messageId) return;
      const cb = isFrame(se.content_block) ? se.content_block : {};
      if (cb.type === 'text' || cb.type === 'thinking') this.blocks.set(key, { parent, index, type: cb.type, text: '' });
      else if (cb.type === 'tool_use') this.blocks.set(key, { parent, index, type: 'tool_use', text: '', toolId: String(cb.id ?? ''), toolName: String(cb.name ?? 'tool') });
      return;
    }
    const block = this.blocks.get(key);
    if (!block) return;
    if (se.type === 'content_block_delta') {
      const d = isFrame(se.delta) ? se.delta : {};
      if (d.type === 'text_delta' && block.type === 'text' && typeof d.text === 'string') block.text += d.text;
      else if (d.type === 'thinking_delta' && block.type === 'thinking' && typeof d.thinking === 'string') block.text += d.thinking;
      else if (d.type === 'input_json_delta' && block.type === 'tool_use' && typeof d.partial_json === 'string') block.text += d.partial_json;
      return;
    }
    if (se.type === 'content_block_stop') {
      if (typeof se.final_text === 'string' && block.type === 'text') block.text = se.final_text; // Codex: the whole text
      if (this.wholeFrames) return; // the whole frame is the item; the block waits for it
      this.blocks.delete(key);
      this.finish(block, e, false);
    }
  }

  private result(e: Frame): void {
    this.flush(); // a turn end closes every block; their rows come before the footer
    this.compacting = null;
    if (e.subtype === 'backfill') return; // the settle that the daemon adds; no client renders it
    if (e.is_error !== true) this.auth = null; // a turn that worked proves the login works
    this.write('result', undefined, e, e);
  }

  private system(e: Frame): void {
    if (e.subtype === 'auth_required') { this.auth = e; return; }
    if (e.subtype === 'status') { this.compacting = e.status === 'compacting' ? e : null; return; }
    if ((e.subtype === 'model' && e.switched === true) || e.subtype === 'settings_refused' || e.subtype === 'spawn_error') {
      this.write('notice', undefined, e, e);
    }
  }

  /** Write the open blocks of one stream (or of all) from their deltas, and forget them. */
  private flush(parent?: string): void {
    for (const [key, block] of [...this.blocks]) {
      if (parent !== undefined && block.parent !== parent) continue;
      this.blocks.delete(key);
      // With whole frames, a block that is still here got none: its message was cut off.
      this.finish(block, undefined, this.wholeFrames);
    }
  }

  private finish(block: OpenBlock, stamp: Frame | undefined, partial: boolean): void {
    const extra = { ...(block.parent ? { parent_tool_use_id: block.parent } : {}), ...(partial ? { partial: true } : {}) };
    if (block.type === 'tool_use') {
      if (!block.toolId) return;
      let input: unknown = {};
      try { input = block.text ? JSON.parse(block.text) : {}; } catch { input = {}; }
      const payload = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: block.toolId, name: block.toolName, input }] }, ...extra };
      this.write('tool', `tu:${block.toolId}`, payload, stamp);
      return;
    }
    if (!block.text.trim()) return;
    const content = block.type === 'text' ? { type: 'text', text: block.text } : { type: 'thinking', thinking: block.text };
    this.write('assistant', undefined, { type: 'assistant', message: { role: 'assistant', content: [content] }, ...extra }, stamp);
  }

  private write(kind: JournalKind, nativeId: string | undefined, payload: unknown, stamp: Frame | undefined): void {
    const seq = this.journal.append(this.terminalId, { kind, nativeId, payload });
    // After the append, so the stored payload has no `seq` of its own: the column is the sequence.
    if (stamp) stamp.seq = seq;
  }

  private warn(err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[journal] could not write an item of thread ${this.terminalId}; the thread goes on without it:`, err instanceof Error ? err.message : err);
  }
}

/** The recorders of the live sessions, by thread. One for the daemon; the three managers share it. */
export class JournalRecorder implements JournalReplaySource {
  private threads = new Map<string, ThreadRecorder>();
  private readonly source: JournalReplaySource;

  constructor(readonly journal: MessageJournal) {
    this.source = createJournalReplay(journal, this);
  }

  /** The replay of a thread for a viewer that connects (see replay.ts), or null when the journal cannot serve it. */
  replay(terminalId: string, opts: JournalReplayOptions): JournalReplay | null {
    return this.source.replay(terminalId, opts);
  }

  /**
   * Record the session behind `ring` from now on. A manager calls this in `spawn`, right after it
   * made the ring and before the first event. A recorder of an earlier session of the thread is
   * closed first (what it streamed and never finished is written).
   */
  attach(terminalId: string, ring: CommitSource, opts: AttachOptions): ThreadRecorder {
    this.threads.get(terminalId)?.close();
    const thread = new ThreadRecorder(this.journal, terminalId, opts.wholeFrames, opts.expectReplay === true);
    this.threads.set(terminalId, thread);
    if (opts.seeds?.length) thread.importSeeds(opts.seeds);
    ring.onCommit = (event) => thread.commit(event);
    return thread;
  }

  /** The thread was deleted: forget its recorder. */
  forget(terminalId: string): void { this.threads.delete(terminalId); }

  openEvents(terminalId: string): unknown[] { return this.threads.get(terminalId)?.openEvents() ?? []; }
  stateEvents(terminalId: string): unknown[] { return this.threads.get(terminalId)?.stateEvents() ?? []; }
}
