// packages/core/src/ws/structured.ts
import type { WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { StructuredSessionManager } from '../structured/manager.js';

export function handleStructuredConnection(
  ws: WebSocket,
  req: IncomingMessage,
  manager: StructuredSessionManager,
  // Hook that lazily revives a thread that died on a daemon restart BEFORE we replay
  // its buffered events — so the resume's history backfill is already in the ring.
  onConnect?: (terminalId: string) => void,
): void {
  const m = req.url?.match(/\/api\/terminals\/([^/]+)\/structured-ws/);
  const id = m?.[1];
  if (!id) { ws.close(4000, 'Invalid URL'); return; }
  try { onConnect?.(id); } catch { /* resume is best-effort; still replay whatever's buffered */ }
  // Replay buffered events, then stream live. A `tail=N` query param bounds replay to the
  // last N ring events instead of the full history — on a long thread (1000+ events) folding
  // every one into a non-virtualized list is what makes chat-open take ~10s; the CLI session
  // itself is resumed independently and sees its full transcript regardless of what we replay.
  const tailParam = Number(new URL(req.url ?? '', 'http://internal').searchParams.get('tail'));
  const events = Number.isFinite(tailParam) && tailParam > 0 ? manager.getEventsTail(id, tailParam) : manager.getEvents(id);
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
