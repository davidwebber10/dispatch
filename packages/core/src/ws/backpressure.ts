import type { WebSocket } from 'ws';
import { wsBufferGraceMs, wsMaxBufferedBytes } from '../caps.js';

interface Watch { timer: ReturnType<typeof setTimeout>; onClose: () => void; /** The queue at the last check; it only shrinks while the client reads. */ sample: number }
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
 * last check (no progress), or at once if it passes 4 times the limit (a hard ceiling for memory). A long history
 * replay does not rely on that ceiling: it waits for room first (`waitForRoom`). Returns true when the data was sent.
 */
export function sendOrDrop(ws: WebSocket, data: string | Buffer, label: string): boolean {
  if (ws.readyState !== 1) return false;
  ws.send(data);
  const cap = wsMaxBufferedBytes();
  if (cap <= 0) return true;
  if (ws.bufferedAmount > cap * HARD_CEILING_FACTOR) {
    console.warn(`[ws] dropped a ${label} client: ${ws.bufferedAmount} bytes unread, over the hard ceiling of ${cap * HARD_CEILING_FACTOR}. It can reconnect.`);
    stop(ws);
    ws.terminate();
    return true;
  }
  if (ws.bufferedAmount > cap && !watchers.has(ws)) watch(ws, label, cap, ws.bufferedAmount);
  return true;
}

/** True when the queue is small enough to send the next replay item without waiting (the same test `waitForRoom` ends on). */
export function hasRoom(ws: WebSocket): boolean {
  if (ws.readyState !== 1) return false;
  const cap = wsMaxBufferedBytes();
  return cap <= 0 || (ws.bufferedAmount ?? 0) <= Math.floor(cap / 2);
}

/**
 * For a long replay: resolves true when the client's queue is at half the limit or less (send the next item), and
 * false when the socket is gone or was dropped for making no progress for DISPATCH_WS_BUFFER_GRACE_MS. A replay that
 * waits here in step with the free space never builds a queue past the limit, so a large history loads on a slow link
 * instead of hitting the hard ceiling on every reconnect. Returns at once when the queue is small.
 */
export async function waitForRoom(ws: WebSocket, label: string): Promise<boolean> {
  if (ws.readyState !== 1) return false;
  const cap = wsMaxBufferedBytes();
  if (cap <= 0) return true;
  const low = Math.floor(cap / 2);
  if ((ws.bufferedAmount ?? 0) <= low) return true;
  const grace = wsBufferGraceMs();
  let sample = ws.bufferedAmount;
  let lastProgress = Date.now();
  for (;;) {
    await new Promise<void>((resolve) => { const t = setTimeout(resolve, Math.min(25, grace)); t.unref?.(); });
    if (ws.readyState !== 1) return false;
    if (ws.bufferedAmount <= low) return true;
    if (ws.bufferedAmount < sample) { sample = ws.bufferedAmount; lastProgress = Date.now(); }
    else if (Date.now() - lastProgress >= grace) {
      console.warn(`[ws] dropped a slow ${label} client during replay: ${ws.bufferedAmount} bytes unread and no progress for ${grace} ms. It can reconnect.`);
      ws.terminate();
      return false;
    }
  }
}

function stop(ws: WebSocket): void {
  const w = watchers.get(ws);
  if (w) { clearTimeout(w.timer); ws.off?.('close', w.onClose); watchers.delete(ws); }
}

function watch(ws: WebSocket, label: string, cap: number, startSample: number): void {
  const onClose = () => stop(ws);
  const arm = () => {
    const timer = setTimeout(() => {
      const w = watchers.get(ws);
      if (!w || ws.readyState !== 1 || ws.bufferedAmount <= cap) return stop(ws); // gone, or drained to the limit
      if (ws.bufferedAmount < w.sample) { w.sample = ws.bufferedAmount; return arm(); } // still reading: look again later
      console.warn(`[ws] dropped a slow ${label} client: ${ws.bufferedAmount} bytes unread and no progress for ${wsBufferGraceMs()} ms (limit ${cap}). It can reconnect.`);
      stop(ws);
      ws.terminate();
    }, wsBufferGraceMs());
    timer.unref?.();
    const prev = watchers.get(ws);
    watchers.set(ws, { timer, onClose, sample: prev?.sample ?? startSample });
  };
  arm();
  ws.once?.('close', onClose);
}
