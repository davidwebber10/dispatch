import { WebSocketServer, type PerMessageDeflateOptions } from 'ws';
import { wsMaxPayload } from '../caps.js';

/**
 * A WebSocket server for browser clients. One message over the cap closes that socket with code 1009
 * (the `ws` default is 100 MiB). `ws` reports that as an 'error' event on the socket, and an 'error'
 * event with no listener throws and takes the daemon down: so every upgraded socket gets a listener here.
 *
 * `deflate: true` (the structured and events servers: JSON text) offers permessage-deflate. The terminal
 * server leaves it off: PTY output is small binary frames, and each key press must not wait on zlib.
 * `DISPATCH_WS_DEFLATE=0` turns it off for every server.
 */
export function createClientWss(maxPayload: number = wsMaxPayload(), opts: { deflate?: boolean } = {}): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload, perMessageDeflate: deflateOptions(opts.deflate) });
  const upgrade = wss.handleUpgrade.bind(wss);
  wss.handleUpgrade = (req, socket, head, cb) => upgrade(req, socket, head, (ws, r) => {
    ws.on('error', () => { /* the close that follows is the whole story */ });
    cb(ws, r);
  });
  return wss;
}

/**
 * Frames under 1 KB go as-is. No context is kept between messages on either side, so an idle socket
 * holds no zlib window (30 open threads would hold 30). At most 10 frames are compressed at one time.
 */
function deflateOptions(deflate: boolean | undefined): PerMessageDeflateOptions | false {
  if (!deflate || process.env.DISPATCH_WS_DEFLATE === '0') return false;
  return { threshold: 1024, serverNoContextTakeover: true, clientNoContextTakeover: true, concurrencyLimit: 10 };
}
