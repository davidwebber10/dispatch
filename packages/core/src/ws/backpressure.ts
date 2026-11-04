import type { WebSocket } from 'ws';
import { wsMaxBufferedBytes } from '../caps.js';

/**
 * Send to a WebSocket client unless it has stopped reading. `ws.send` queues in memory, so a stalled browser (a
 * sleeping phone, a dead network that has not timed out) would make the daemon keep every terminal and event byte
 * for it. Past DISPATCH_WS_MAX_BUFFERED_BYTES the client is dropped: the socket is terminated (a close handshake
 * cannot finish while the buffer is full) and the browser reconnects and replays. Returns true when the data was sent.
 */
export function sendOrDrop(ws: WebSocket, data: string | Buffer, label: string): boolean {
  if (ws.readyState !== 1) return false;
  const cap = wsMaxBufferedBytes();
  if (cap > 0 && ws.bufferedAmount > cap) {
    console.warn(`[ws] dropped a slow ${label} client: ${ws.bufferedAmount} bytes unread (limit ${cap}). It can reconnect.`);
    ws.terminate();
    return false;
  }
  ws.send(data);
  return true;
}
