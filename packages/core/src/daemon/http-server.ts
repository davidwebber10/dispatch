import http from 'http';
import type express from 'express';

/** The HTTP server of the daemon. `Daemon.attach` adds the WebSocket upgrade handler to it. */
export function createDaemonHttpServer(app: express.Express): http.Server {
  const server = http.createServer(app);
  server.keepAliveTimeout = 75_000; // W2-H: Node's 5 s made a direct http page (Tailscale) open a new connection after each short pause
  server.headersTimeout = 76_000;   // must be above keepAliveTimeout, or a request that lands as the timer ends is cut
  return server;
}
