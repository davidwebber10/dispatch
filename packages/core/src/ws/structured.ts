// packages/core/src/ws/structured.ts
import type { WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { IStructuredManager } from '../structured/manager.js';
import { sendOrDrop, waitForRoom, hasRoom, HARD_CEILING_FACTOR } from './backpressure.js';
import { wsMaxBufferedBytes } from '../caps.js';
import type { StatusSnapshot } from '../status/events.js';

/**
 * The status authority as this socket needs it (W3-C): StatusService. `snapshot` is the status as last
 * committed (null for an unknown thread); `onStatus` calls back after each committed transition and
 * returns the function that removes the listener.
 */
export interface StatusSource {
  snapshot(terminalId: string): StatusSnapshot | null;
  onStatus(listener: (terminalId: string, snapshot: StatusSnapshot) => void): () => void;
}

/** The frame that carries a status snapshot: the first frame of a connection, then one per transition. */
function statusFrame(snapshot: StatusSnapshot): { type: 'system'; subtype: 'status' } & StatusSnapshot {
  return { type: 'system', subtype: 'status', ...snapshot };
}

/**
 * True iff at least one ring event would fold into a VISIBLE conversation item in the
 * client (useStructuredChat's onEvent): a non-synthetic user turn (string or
 * text/tool_result/image blocks), an assistant turn with text/thinking/tool_use/image
 * blocks, or a streamed content_block_start. system/*, result footers, control frames
 * and delta-only stream noise render nothing on their own. Drives the `system/inactive`
 * REST-hydration sentinel below: a ring with no renderable events replays "something"
 * but paints nothing, which used to strand the view (the 0b8e106 deadlock).
 */
export function hasRenderableEvents(events: unknown[]): boolean {
  return events.some((e: any) => {
    if (!e || typeof e !== 'object') return false;
    if (e.type === 'assistant') {
      const c = e.message?.content;
      if (!Array.isArray(c)) return false;
      return c.some((b: any) => b && (b.type === 'tool_use' || b.type === 'thinking' || b.type === 'image'
        || (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0)));
    }
    if (e.type === 'user') {
      if (e.isSynthetic || e.isMeta || !e.message) return false;
      const c = e.message.content;
      if (typeof c === 'string') return c.trim().length > 0;
      if (!Array.isArray(c)) return false;
      return c.some((b: any) => b && (b.type === 'tool_result' || b.type === 'image'
        || (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0)));
    }
    if (e.type === 'stream_event') return e.event?.type === 'content_block_start';
    return false;
  });
}

/**
 * True when replaying `events` would leave the client's busy spinner LATCHED: the last
 * busy-affecting event is a stream_event or a whole `assistant` (both set busy=true in
 * useStructuredChat) with no `result` (or surfaced permission) after it to clear it. A ring
 * ends this way when a process was killed mid-turn (its closing result was never written)
 * or a bounded tail sliced mid-turn.
 */
function replayLeavesBusy(events: unknown[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e: any = events[i];
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'result' || e.type === 'permission') return false;
    if (e.type === 'stream_event' && e.event) return true;
    if (e.type === 'assistant' && Array.isArray(e.message?.content)) return true;
  }
  return false;
}

export function handleStructuredConnection(
  ws: WebSocket,
  req: IncomingMessage,
  manager: IStructuredManager,
  // Hook that lazily revives a thread that died on a daemon restart BEFORE we replay
  // its buffered events — so the resume's history backfill is already in the ring.
  // Returns whether a live process now backs the thread (true if already alive, or
  // successfully revived); false for e.g. an archived thread, which is deliberately
  // never revived (see service.ts's ensureStructuredAlive).
  onConnect?: (terminalId: string) => boolean | void,
  /**
   * True when this thread's history lives in a durable transcript the client can page over
   * REST, so the ring holds only a COPY of it (Codex backfills one on every resume).
   * Replaying that copy renders every turn twice for a harness whose items carry no
   * per-message uuid to dedup on — the client's fallback is a content fingerprint, and the
   * ws and REST translators do not produce matching ones for tool calls. Such a thread gets
   * NO replay: the `system/inactive` sentinel below hands the whole view to REST, which is
   * the same path an archived thread already takes.
   */
  restOwnsHistory?: (terminalId: string) => boolean,
  /**
   * True when the client can recover anything the `tail=N` bound cuts by paging the REST
   * transcript (loadOlder) — Claude Code. For a harness with NO pageable transcript (Grok:
   * getConversation → unsupported), the bound would silently AMPUTATE history — one chatty
   * turn (~1600 word-delta events) pushes the whole conversation above a 200-event tail and
   * a reopened thread shows nothing but the result footer — so such threads replay the FULL
   * ring instead. Absent ⇒ the bound applies (the pre-Grok default).
   */
  restCanPageHistory?: (terminalId: string) => boolean,
  /**
   * True when the daemon's own status for this thread says it is NOT mid-turn (anything but
   * 'working'). When the replay would leave busy latched (see replayLeavesBusy) on a thread
   * that is actually settled, the handler appends the synthetic `result` the client swallows
   * (`subtype: 'backfill'`, same shape cc-sessions.ts uses) so the chat never shows a
   * phantom "Working…". Absent ⇒ no settle is ever appended (no authority, no guess).
   */
  isThreadSettled?: (terminalId: string) => boolean,
  /**
   * The model the thread runs NOW (SessionService.activeModel). Sent as the last replay frame,
   * `{type:'system', subtype:'model', model}`, so it wins over any older model in the replay:
   * Claude emits system/init only once per turn, a bounded tail can cut it, and a Codex ring is
   * not replayed at all, so without it the Pretty header had no model or a stale one.
   */
  currentModel?: (terminalId: string) => string | undefined,
  /**
   * A question the thread asked before a daemon restart (W2-C): the manager's memory lost it, the
   * database kept it. Sent as the same `permission` frame as a live one, so the same inline card shows.
   */
  restoredPending?: (terminalId: string) => unknown,
  /**
   * The status authority (W3-C). With it, the first frame of the connection is the status snapshot
   * (`{ type: 'system', subtype: 'status', status, turnOpen, generation, sequence, at, activity }`), before
   * the replay, and each committed transition sends the same frame live. The client shows "Working" from
   * `turnOpen` and no longer from the frames it sees. Absent, or a thread it does not know: no status frame
   * (the client then keeps its old fold of the frames).
   */
  status?: StatusSource,
): void {
  const m = req.url?.match(/\/api\/terminals\/([^/]+)\/structured-ws/);
  const id = m?.[1];
  if (!id) { ws.close(4000, 'Invalid URL'); return; }
  // Revive a thread that died on a daemon restart BEFORE we read the ring, so a resume's
  // history backfill is already buffered and shows up in the replay below. Best-effort; the
  // return value is no longer needed here — the sentinel decision is based on what's actually
  // in the ring (see below), not on liveness.
  try { onConnect?.(id); } catch { /* resume is best-effort; still replay whatever's buffered */ }
  // Replay buffered events, then stream live. A `tail=N` query param bounds replay to the
  // last N ring events instead of the full history — on a long thread (1000+ events) folding
  // every one into a non-virtualized list is what makes chat-open take ~10s; the CLI session
  // itself is resumed independently and sees its full transcript regardless of what we replay.
  const tailParam = Number(new URL(req.url ?? '', 'http://internal').searchParams.get('tail'));
  // A predicate that throws must never silently drop a thread's history — replay by default.
  let restOwned = false;
  try { restOwned = restOwnsHistory?.(id) === true; } catch { restOwned = false; }
  // Same failure posture: on a throwing predicate, prefer the full replay over amputation.
  let tailRecoverable = restCanPageHistory === undefined;
  try { tailRecoverable = restCanPageHistory ? restCanPageHistory(id) === true : tailRecoverable; } catch { tailRecoverable = false; }
  const events = restOwned
    ? []
    : (tailRecoverable && Number.isFinite(tailParam) && tailParam > 0 ? manager.getEventsTail(id, tailParam) : manager.getEvents(id));
  // Nothing RENDERABLE to replay ⇒ the client would sit on an empty view: the live channel
  // only carries FUTURE turns, and any history not in the ring never reaches it this way.
  // Tell the client to hydrate its initial view from the REST transcript instead. Covers a
  // dead/archived/queued thread (ring empty), an ALIVE thread whose ring is empty after a
  // daemon restart, AND a ring holding only non-rendering events (system/init, a stale
  // result) — that last case previously replayed "something", earned no sentinel, and
  // painted nothing, the deadlock 0b8e106 worked around client-side with an anchorless
  // newest-window fetch (since removed: it raced the replay and doubled transcripts). Sent
  // BEFORE replay; harmless alongside one, since the client only hydrates while nothing
  // conversational is rendered (see useStructuredChat's 'system'/'inactive' handler).
  // The frames the client gets first, in order: the status header (W3-C), the sentinel, the replay, the settle, the pending permission.
  // They are sent in step with the client's free buffer space (see below); live events that arrive meanwhile wait behind them.
  const frames: unknown[] = [];
  // W3-C: the status header. It is the first frame, so the client knows `turnOpen` before it folds one
  // replayed frame. A source that throws costs the header only, never the replay.
  let header: StatusSnapshot | null = null;
  try { header = status?.snapshot(id) ?? null; } catch { header = null; }
  if (header) frames.push(statusFrame(header));
  if (!hasRenderableEvents(events)) frames.push({ type: 'system', subtype: 'inactive' });
  for (const e of events) frames.push(e);
  // Phantom-"Working…" guard: a replay that ends mid-turn latches the client's busy spinner.
  // If the daemon's own status says this thread is settled — and no pending permission is
  // about to be surfaced (that frame clears busy itself) — append the swallowed settle.
  // REMOVE AFTER v4.5.0 (W3-C): a client from v4.5.0 on reads `turnOpen` from the status header and ignores
  // this frame for "busy". It stays one release for a cached older web build, with `replayLeavesBusy` and
  // the `isThreadSettled` parameter. The release note of v4.5.0 names the removal.
  let settled = false;
  try { settled = isThreadSettled?.(id) === true; } catch { settled = false; }
  if (settled && !manager.getPending(id) && replayLeavesBusy(events)) {
    frames.push({ type: 'result', subtype: 'backfill', is_error: false });
  }
  let model: string | undefined;
  try { model = currentModel?.(id); } catch { model = undefined; }
  if (model) frames.push({ type: 'system', subtype: 'model', model });
  // Replay a still-pending permission on (re)connect so a refresh re-surfaces it.
  let initialPending: unknown = manager.getPending(id);
  if (!initialPending) { try { initialPending = restoredPending?.(id) ?? null; } catch { initialPending = null; } }
  if (initialPending) frames.push({ type: 'permission', pending: initialPending });
  // Live events during the replay are held and sent after it, so the order the client sees is unchanged. The held
  // list is bounded (by 4 times the back-pressure limit, in bytes, the same as the hard ceiling): a client that cannot keep up with the history while the
  // thread keeps producing output is dropped, not allowed to grow the daemon's memory.
  let replaying = true;
  const held: string[] = [];
  let heldBytes = 0;
  const emit = (json: string) => {
    if (!replaying) { sendOrDrop(ws, json, 'chat'); return; }
    const cap = wsMaxBufferedBytes() * HARD_CEILING_FACTOR; // the same bound the socket queue itself has
    heldBytes += Buffer.byteLength(json); // bytes on the wire, not UTF-16 units: CJK and emoji are 3 to 4 bytes
    if (cap > 0 && heldBytes > cap) {
      console.warn(`[ws] dropped a slow chat client: ${heldBytes} bytes of live output waiting behind its replay (limit ${cap}). It can reconnect.`);
      held.length = 0; heldBytes = 0;
      ws.terminate();
      return;
    }
    held.push(json);
  };
  const onEvent = (eid: string, event: unknown) => { if (eid === id) emit(JSON.stringify(event)); };
  // P0b: the CLI never emits a `result` when its process exits/crashes mid-turn,
  // so the client's `busy` would spin forever. Synthesize one from the manager's
  // 'exit' so the existing result handler clears `busy` and shows the error.
  // `detail` is the CLI's stderr tail, when it wrote one: often the only place it says why (#76).
  const onExit = (eid: string, code: number, detail?: string) => {
    if (eid === id) {
      emit(JSON.stringify({ type: 'result', is_error: true, subtype: 'process_exit', result: `Process exited (${code})${detail ? `: ${detail}` : ''}` }));
    }
  };
  // Forward escalations (the membrane) so a structured chat view can render the
  // pending gated tool / question inline too, not just the Overseer Needs zone.
  const onPermission = (eid: string, pending: unknown) => {
    if (eid === id) emit(JSON.stringify({ type: 'permission', pending }));
  };
  // A pending that went away (answered, cancelled, stale at a turn end) clears every viewer's
  // card. A separate manager event, because a `permission` emit means a NEW request to status.
  const onCleared = (eid: string) => {
    if (eid === id) emit(JSON.stringify({ type: 'permission', pending: null }));
  };
  manager.on('event', onEvent);
  manager.on('exit', onExit);
  manager.on('permission', onPermission);
  manager.on('permission-cleared', onCleared);
  // W3-C: the live status frame. One per committed transition of this thread, in the commit order; it waits
  // behind the replay like every live event, so it never arrives before the header.
  let offStatus: (() => void) | undefined;
  try {
    offStatus = status?.onStatus((tid, snapshot) => { if (tid === id) emit(JSON.stringify(statusFrame(snapshot))); });
  } catch { offStatus = undefined; }
  ws.on('close', () => {
    manager.off('event', onEvent); manager.off('exit', onExit); manager.off('permission', onPermission);
    manager.off('permission-cleared', onCleared);
    try { offStatus?.(); } catch { /* the listener list is gone with the service */ }
  });
  // Send the frames, then the live events held meanwhile, one at a time. Each waits until the client has room (half
  // the back-pressure limit), so neither a big history nor a backlog of held events is queued all at once. There is
  // no await when there is room, so a replay to a client that keeps up runs synchronously.
  //
  // `batch=1` (W2-I): the frames go as ONE message, `{ type: 'replay', done, events: [...] }`. 200 small frames are
  // each under the 1 KB compression threshold and each costs a frame header and a client task; one message is
  // compressed as a whole and the client folds it in one render. A history over half the back-pressure limit is cut
  // into several such messages (`done` is true on the last), sent in step with the free space as before. A client that
  // does not ask (an older web build) gets the frames one by one, unchanged. Live events are never batched.
  const batch = wantsBatch(req.url);
  void (async () => {
    let i = 0;
    try {
      if (batch) {
        const cap = wsMaxBufferedBytes();
        const limit = cap > 0 ? Math.floor(cap / 2) : Number.POSITIVE_INFINITY;
        while (i < frames.length) {
          const parts: string[] = [JSON.stringify(frames[i++])];
          let bytes = Buffer.byteLength(parts[0]);
          while (i < frames.length) {
            const next = JSON.stringify(frames[i]);
            const size = Buffer.byteLength(next) + 1;
            if (bytes + size > limit) break;
            parts.push(next); bytes += size; i++;
          }
          if (!hasRoom(ws) && !(await waitForRoom(ws, 'chat'))) return;
          sendOrDrop(ws, `{"type":"replay","done":${i >= frames.length},"events":[${parts.join(',')}]}`, 'chat');
        }
      }
      for (;;) {
        let json: string;
        if (i < frames.length) json = JSON.stringify(frames[i++]);
        else if (held.length > 0) { json = held.shift()!; heldBytes -= Buffer.byteLength(json); }
        else break; // nothing left; `replaying` is cleared below in the same tick, so no live event slips between
        if (!hasRoom(ws) && !(await waitForRoom(ws, 'chat'))) return;
        sendOrDrop(ws, json, 'chat');
      }
    } finally {
      replaying = false;
      held.length = 0; heldBytes = 0;
    }
  })();
}

/** `batch=1` on the URL: this client folds a `{ type: 'replay', events }` message (W2-I). */
function wantsBatch(url: string | undefined): boolean {
  try { return new URL(url ?? '', 'http://internal').searchParams.get('batch') === '1'; } catch { return false; }
}
