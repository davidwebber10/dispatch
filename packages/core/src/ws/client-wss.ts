import { WebSocketServer, type PerMessageDeflateOptions, type WebSocket } from 'ws';
import { wsMaxPayload } from '../caps.js';

/** Sockets whose next `send` is the one to compress (see `sendCompressed`). */
const compressNext = new WeakSet<WebSocket>();

/**
 * A WebSocket server for browser clients. One message over the cap closes that socket with code 1009
 * (the `ws` default is 100 MiB). `ws` reports that as an 'error' event on the socket, and an 'error'
 * event with no listener throws and takes the daemon down: so every upgraded socket gets a listener here.
 *
 * `deflate: true` (the structured and events servers: JSON text) offers permessage-deflate and compresses
 * every frame of 1 KB or more.
 *
 * The default (the terminal server) offers permessage-deflate too, but compresses only what is sent through
 * `sendCompressed`: the scrollback replay, which is megabytes of text and escape codes on each connect (W2-I).
 * Live PTY output goes as it is, so an echo of a key press never waits on zlib.
 *
 * `deflate: false`, or `DISPATCH_WS_DEFLATE=0` for every server, turns the extension off.
 */
export function createClientWss(maxPayload: number = wsMaxPayload(), opts: { deflate?: boolean } = {}): WebSocketServer {
  const replayOnly = opts.deflate === undefined;
  const wss = new WebSocketServer({ noServer: true, maxPayload, perMessageDeflate: deflateOptions(replayOnly ? true : opts.deflate) });
  const upgrade = wss.handleUpgrade.bind(wss);
  wss.handleUpgrade = (req, socket, head, cb) => upgrade(req, socket, head, (ws, r) => {
    ws.on('error', () => { /* the close that follows is the whole story */ });
    if (replayOnly) compressOnlyOnRequest(ws);
    cb(ws, r);
  });
  return wss;
}

/**
 * Runs `send` (one `ws.send`, usually through `sendOrDrop`) with compression on for that message. On a socket of a
 * `deflate: true` server, or one with no extension, it changes nothing.
 */
export function sendCompressed<T>(ws: WebSocket, send: () => T): T {
  compressNext.add(ws);
  try { return send(); } finally { compressNext.delete(ws); }
}

/** Makes `compress: false` the default of this socket's `send`; a send inside `sendCompressed` is compressed. */
function compressOnlyOnRequest(ws: WebSocket): void {
  type Done = (err?: Error) => void;
  const send = ws.send.bind(ws) as (data: unknown, options: object, cb?: Done) => void;
  ws.send = ((data: unknown, options?: object | Done, cb?: Done) => {
    const compress = compressNext.has(ws);
    if (typeof options === 'function') send(data, { compress }, options as Done);
    else send(data, { compress, ...options }, cb);
  }) as WebSocket['send'];
}

/**
 * Frames under 1 KB go as-is. No context is kept between messages on either side, so an idle socket
 * holds no zlib window (30 open threads would hold 30). At most 10 frames are compressed at one time.
 */
function deflateOptions(deflate: boolean | undefined): PerMessageDeflateOptions | false {
  if (!deflate || process.env.DISPATCH_WS_DEFLATE === '0') return false;
  return { threshold: 1024, serverNoContextTakeover: true, clientNoContextTakeover: true, concurrencyLimit: 10 };
}
