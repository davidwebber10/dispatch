// packages/core/src/ws/structured.ts
import type { WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { IStructuredManager } from '../structured/manager.js';

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
  const events = Number.isFinite(tailParam) && tailParam > 0 ? manager.getEventsTail(id, tailParam) : manager.getEvents(id);
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
  if (!hasRenderableEvents(events) && ws.readyState === 1) ws.send(JSON.stringify({ type: 'system', subtype: 'inactive' }));
  for (const e of events) { if (ws.readyState === 1) ws.send(JSON.stringify(e)); }
  const onEvent = (eid: string, event: unknown) => { if (eid === id && ws.readyState === 1) ws.send(JSON.stringify(event)); };
  // P0b: the CLI never emits a `result` when its process exits/crashes mid-turn,
  // so the client's `busy` would spin forever. Synthesize one from the manager's
  // 'exit' so the existing result handler clears `busy` and shows the error.
  const onExit = (eid: string, code: number) => {
    if (eid === id && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'result', is_error: true, subtype: 'process_exit', result: `Process exited (${code})` }));
    }
  };
  // Forward escalations (the membrane) so a structured chat view can render the
  // pending gated tool / question inline too, not just the Overseer Needs zone.
  const onPermission = (eid: string, pending: unknown) => {
    if (eid === id && ws.readyState === 1) ws.send(JSON.stringify({ type: 'permission', pending }));
  };
  // Replay a still-pending permission on (re)connect so a refresh re-surfaces it.
  const initialPending = manager.getPending(id);
  if (initialPending && ws.readyState === 1) ws.send(JSON.stringify({ type: 'permission', pending: initialPending }));
  manager.on('event', onEvent);
  manager.on('exit', onExit);
  manager.on('permission', onPermission);
  ws.on('close', () => { manager.off('event', onEvent); manager.off('exit', onExit); manager.off('permission', onPermission); });
}
