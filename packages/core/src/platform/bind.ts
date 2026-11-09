import fs from 'node:fs';
import type http from 'http';
import net from 'net';
import path from 'node:path';

/**
 * `DISPATCH_BIND`: the address the daemon listens on (engineering program W1-B).
 *
 * Unset, the daemon listens on every interface, as it always did. Set to an IP address or to `localhost`,
 * it listens on that address only. The loopback guard (platform/loopback-guard.ts) still holds 127.0.0.1
 * and ::1, because the threads, the hooks and the `dispatch` CLI call the daemon on 127.0.0.1.
 */

/**
 * The host to listen on, or undefined for "every interface" (the old call). An IP literal or `localhost` only:
 * a name would be resolved at start, and a typing error would then listen on an address nobody chose.
 * An invalid value throws; the message is the one line the daemon prints.
 */
export function parseBindHost(raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim();
  if (value === '') return undefined;
  const bare = /^\[.*\]$/.test(value) ? value.slice(1, -1) : value; // [::1] is ::1
  if (net.isIP(bare) !== 0) return bare;
  if (bare.toLowerCase() === 'localhost') return 'localhost';
  const err = new Error(
    `DISPATCH_BIND=${JSON.stringify(raw)} is not valid. Use an IP address of this computer (for example 127.0.0.1) or "localhost", or remove the variable to listen on all interfaces. The daemon did not start.`,
  );
  // The caller prints the error object. Without the frames it is one line.
  err.stack = `${err.name}: ${err.message}`;
  throw err;
}

/** `server.listen` with the host only when one is set, so the unset case is the same call as before. */
export function listenOn(server: http.Server, port: number, host: string | undefined, onListening: () => void): void {
  if (host === undefined) server.listen(port, onListening);
  else server.listen(port, host, onListening);
}

/** `<dataDir>/listen.json`: what the running daemon listens on. `dispatch status` reads it. No secret is in it. */
export const LISTEN_FILE = 'listen.json';
export interface ListenInfo {
  pid: number;
  port: number;
  /** The address of DISPATCH_BIND as the socket reports it, or null for every interface. */
  bind: string | null;
}

/** Written once the port is bound. Never throws: a failed write only costs the status line. */
export function writeListenInfo(dataDir: string, info: { port: number; bind: string | null }, pid: number = process.pid): void {
  try {
    fs.writeFileSync(path.join(dataDir, LISTEN_FILE), JSON.stringify({ pid, port: info.port, bind: info.bind }) + '\n', { mode: 0o600 });
  } catch { /* status then says nothing about the address */ }
}

export function readListenInfo(dataDir: string): ListenInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, LISTEN_FILE), 'utf8')) as Partial<ListenInfo>;
    if (typeof raw.pid !== 'number' || typeof raw.port !== 'number') return null;
    return { pid: raw.pid, port: raw.port, bind: typeof raw.bind === 'string' ? raw.bind : null };
  } catch { return null; }
}
