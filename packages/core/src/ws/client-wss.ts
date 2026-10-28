import { WebSocketServer } from 'ws';
import { wsMaxPayload } from '../caps.js';

/**
 * A WebSocket server for browser clients. One message over the cap closes that socket with code 1009
 * (the `ws` default is 100 MiB). `ws` reports that as an 'error' event on the socket, and an 'error'
 * event with no listener throws and takes the daemon down: so every upgraded socket gets a listener here.
 */
export function createClientWss(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: wsMaxPayload() });
  const upgrade = wss.handleUpgrade.bind(wss);
  wss.handleUpgrade = (req, socket, head, cb) => upgrade(req, socket, head, (ws, r) => {
    ws.on('error', () => { /* the close that follows is the whole story */ });
    cb(ws, r);
  });
  return wss;
}
