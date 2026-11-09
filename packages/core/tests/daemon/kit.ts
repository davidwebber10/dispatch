// Shared by the daemon tests: one temp data dir, one in-memory database and one HTTP server on 127.0.0.1 for each build.
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { FakeManager } from '../endless/fake-manager.js';
import { buildDaemon, NoopPTYManager, type BuildDaemonOptions, type Daemon } from '../../src/daemon/build.js';

export interface Kit {
  daemon: Daemon;
  db: Database.Database;
  dir: string;
  manager: FakeManager;
  /** The peer address that the daemon sees for the next requests (supertest always connects from loopback). */
  peer: { address: string };
  /** A server on 127.0.0.1 that serves the daemon app behind the fake peer address. `attach` is already called on it. */
  server(): Promise<http.Server>;
  port(): Promise<number>;
}

const open: { daemon: Daemon; db: Database.Database; dir: string; servers: http.Server[] }[] = [];

export function kit(opts: Partial<BuildDaemonOptions> = {}): Kit {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-kit-'));
  const db = new Database(':memory:');
  initSchema(db);
  const manager = new FakeManager();
  const daemon = buildDaemon({
    db, dataDir: dir, auth: 'open', network: false, timers: false, webDist: null, bundledDir: null,
    pty: new NoopPTYManager(), managers: { 'claude-code': manager.asManager() }, ...opts,
  });
  const peer = { address: '127.0.0.1' };
  const entry = { daemon, db, dir, servers: [] as http.Server[] };
  open.push(entry);
  let listening: Promise<http.Server> | null = null;
  const server = () => listening ??= new Promise<http.Server>((resolve) => {
    const outer = express();
    outer.use((req, _res, next) => { Object.defineProperty(req.socket, 'remoteAddress', { value: peer.address, configurable: true }); next(); });
    outer.use(daemon.app);
    const s = http.createServer(outer);
    entry.servers.push(s);
    daemon.attach(s);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { daemon, db, dir, manager, peer, server, port: async () => ((await server()).address() as { port: number }).port };
}

/** Call from afterEach: stops every build of the test, closes its servers and removes its data dir. */
export function closeKits(): void {
  for (const k of open.splice(0)) {
    try { k.daemon.stop(); } catch { /* a test may have stopped it */ }
    for (const s of k.servers) { s.close(); s.closeAllConnections(); }
    if (k.db.open) k.db.close();
    fs.rmSync(k.dir, { recursive: true, force: true });
  }
}
