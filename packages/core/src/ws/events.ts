import { WebSocket, WebSocketServer } from 'ws';
import { sendOrDrop } from './backpressure.js';

export interface EventBroadcaster {
  broadcast(event: Record<string, unknown>): void;
}

/** The page's liveness check: it sends this text and expects PONG back (2026-11-05). */
export const EVENTS_PING = 'ping';
export const EVENTS_PONG = JSON.stringify({ type: 'pong' });

/**
 * Answer the page's liveness check on one events socket. Returning from the background, the
 * phone asks "still there?" instead of tearing down and rebuilding every view; WebSocket
 * protocol pings are invisible to page code, so this is an ordinary message. Anything else
 * the page sends is ignored, as before.
 */
export function answerEventsPing(ws: WebSocket): void {
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    if (data.toString() === EVENTS_PING && ws.readyState === WebSocket.OPEN) ws.send(EVENTS_PONG);
  });
}

export function createEventsBroadcaster(wss: WebSocketServer): EventBroadcaster {
  return {
    broadcast(event) {
      const msg = JSON.stringify(event);
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          sendOrDrop(client, msg, 'events');
        }
      }
    },
  };
}

/** No-op broadcaster for testing (no WebSocket server needed) */
export function createNoopBroadcaster(): EventBroadcaster {
  return {
    broadcast() {},
  };
}
