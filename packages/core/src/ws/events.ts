import { WebSocket, WebSocketServer } from 'ws';
import { sendOrDrop } from './backpressure.js';

export interface EventBroadcaster {
  broadcast(event: Record<string, unknown>): void;
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
