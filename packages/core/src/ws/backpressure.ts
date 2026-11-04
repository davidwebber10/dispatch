import type { WebSocket } from 'ws';
import { wsBufferGraceMs, wsMaxBufferedBytes } from '../caps.js';

const watchers = new WeakMap<WebSocket, ReturnType<typeof setTimeout>>();

/**
 * Send to a WebSocket client, and drop it if it has stopped reading. `ws.send` queues in memory, so a stalled
 * browser (a sleeping phone, a dead network that has not timed out) would make the daemon keep every terminal and
 * event byte for it.
 *
 * One big send fills the queue at once and a healthy socket drains it a moment later, so the queue size alone does not
 * mean a stall. When a socket goes over DISPATCH_WS_MAX_BUFFERED_BYTES a timer starts (DISPATCH_WS_BUFFER_GRACE_MS).
 * If the socket is still over the limit when it fires, the socket is terminated (a close handshake cannot finish with a
 * full buffer) and the browser reconnects and replays. Sends continue during the grace time, so memory is bounded by
 * the limit plus the output of that time. Returns true when the data was sent.
 */
export function sendOrDrop(ws: WebSocket, data: string | Buffer, label: string): boolean {
  if (ws.readyState !== 1) return false;
  ws.send(data);
  const cap = wsMaxBufferedBytes();
  if (cap > 0 && ws.bufferedAmount > cap && !watchers.has(ws)) {
    const onClose = () => { clearTimeout(timer); watchers.delete(ws); };
    const timer = setTimeout(() => {
      watchers.delete(ws);
      ws.off?.('close', onClose); // a drained socket must not keep one listener per burst
      if (ws.readyState !== 1 || ws.bufferedAmount <= cap) return;
      console.warn(`[ws] dropped a slow ${label} client: ${ws.bufferedAmount} bytes unread for over ${wsBufferGraceMs()} ms (limit ${cap}). It can reconnect.`);
      ws.terminate();
    }, wsBufferGraceMs());
    timer.unref?.();
    watchers.set(ws, timer);
    ws.once?.('close', onClose);
  }
  return true;
}
