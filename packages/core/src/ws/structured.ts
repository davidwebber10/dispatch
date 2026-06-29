// packages/core/src/ws/structured.ts
import type { WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { StructuredSessionManager } from '../structured/manager.js';

export function handleStructuredConnection(ws: WebSocket, req: IncomingMessage, manager: StructuredSessionManager): void {
  const m = req.url?.match(/\/api\/terminals\/([^/]+)\/structured-ws/);
  const id = m?.[1];
  if (!id) { ws.close(4000, 'Invalid URL'); return; }
  // Replay buffered events, then stream live.
  for (const e of manager.getEvents(id)) { if (ws.readyState === 1) ws.send(JSON.stringify(e)); }
  const onEvent = (eid: string, event: unknown) => { if (eid === id && ws.readyState === 1) ws.send(JSON.stringify(event)); };
  // P0b: the CLI never emits a `result` when its process exits/crashes mid-turn,
  // so the client's `busy` would spin forever. Synthesize one from the manager's
  // 'exit' so the existing result handler clears `busy` and shows the error.
  const onExit = (eid: string, code: number) => {
    if (eid === id && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'result', is_error: true, subtype: 'process_exit', result: `Process exited (${code})` }));
    }
  };
  manager.on('event', onEvent);
  manager.on('exit', onExit);
  ws.on('close', () => { manager.off('event', onEvent); manager.off('exit', onExit); });
}
