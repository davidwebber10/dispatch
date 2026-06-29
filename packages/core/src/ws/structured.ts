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
  manager.on('event', onEvent);
  ws.on('close', () => manager.off('event', onEvent));
}
