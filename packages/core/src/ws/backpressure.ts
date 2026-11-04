import type { WebSocket } from 'ws';
import { wsBufferGraceMs, wsMaxBufferedBytes } from '../caps.js';

interface Watch { timer: ReturnType<typeof setTimeout>; onClose: () => void }
const watchers = new WeakMap<WebSocket, Watch>();

/** A queue this many times the limit is dropped at once, whatever the client is doing. */
export const HARD_CEILING_FACTOR = 4;

/**
 * Send to a WebSocket client, and drop it if it has stopped reading. `ws.send` queues in memory, so a stalled
 * browser (a sleeping phone, a dead network that has not timed out) would make the daemon keep every terminal and
 * event byte for it.
 *
 * Over DISPATCH_WS_MAX_BUFFERED_BYTES is not a stall by itself: one big send fills the queue at once, and a slow link
 * (a phone on cellular opening a chat with images) drains it slowly but steadily. When a socket goes over the limit a
 * check runs every DISPATCH_WS_BUFFER_GRACE_MS. The client is dropped only if the queue did NOT get smaller since the
 * last check (no progress), or at once if it passes 4 times the limit (a hard ceiling for memory). A client whose
 * queue falls to the limit or below is left alone. Sends continue while it is checked. Returns true when sent.
 */
export function sendOrDrop(ws: WebSocket, data: string | Buffer, label: string): boolean {
  if (ws.readyState !== 1) return false;
  ws.send(data);
  const cap = wsMaxBufferedBytes();
  if (cap <= 0) return true;
  if (ws.bufferedAmount > cap * HARD_CEILING_FACTOR) {
    console.warn(`[ws] dropped a ${label} client: ${ws.bufferedAmount} bytes unread, over the hard ceiling of ${cap * HARD_CEILING_FACTOR}. It can reconnect.`);
    ws.terminate();
    return true;
  }
  if (ws.bufferedAmount > cap && !watchers.has(ws)) watch(ws, label, cap, ws.bufferedAmount);
  return true;
}

function watch(ws: WebSocket, label: string, cap: number, startSample: number): void {
  let sample = startSample;
  const stop = () => {
    const w = watchers.get(ws);
    if (w) { clearTimeout(w.timer); ws.off?.('close', w.onClose); watchers.delete(ws); }
  };
  const onClose = () => stop();
  const arm = () => {
    const timer = setTimeout(() => {
      if (ws.readyState !== 1 || ws.bufferedAmount <= cap) return stop(); // gone, or drained to the limit
      if (ws.bufferedAmount < sample) { sample = ws.bufferedAmount; return arm(); } // still reading: look again later
      console.warn(`[ws] dropped a slow ${label} client: ${ws.bufferedAmount} bytes unread and no progress for ${wsBufferGraceMs()} ms (limit ${cap}). It can reconnect.`);
      stop();
      ws.terminate();
    }, wsBufferGraceMs());
    timer.unref?.();
    watchers.set(ws, { timer, onClose });
  };
  arm();
  ws.once?.('close', onClose);
}
