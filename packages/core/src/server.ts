/**
 * The entry of the daemon. Everything is built in `daemon/build.ts` (W3-A): `createApp` is the test
 * build of it, and `startServer` is the daemon: build, attach, listen, boot recover, start timers.
 */
import { KILL_GRACE_MS } from './platform/kill-grace.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { AddressInfo } from 'node:net';
import type express from 'express';
import type Database from 'better-sqlite3';
import { createDatabase } from './db/connection.js';
import * as sessionsDb from './db/sessions.js';
import type { KeyRegistry } from './auth/principals.js';
import { lockDownDataDir } from './auth/private-dir.js';
import { writeOwnPid, removeOwnPid } from './platform/pid-file.js';
import { installProcessGuards } from './runtime/process-guards.js';
import { platform } from './platform/index.js';
import { guardLoopback } from './platform/loopback-guard.js';
import { listenOn, parseBindHost, writeListenInfo } from './platform/bind.js';
import type { SecretsService } from './secrets/service.js';
import type { EndlessService } from './endless/service.js';
import type { AssistRunner } from './assist/run.js';
import type { IStructuredManager } from './structured/manager.js';
import type { ApiRouteDeps } from './server-routes.js';
import { buildDaemon, NoopPTYManager } from './daemon/build.js';
import { createDaemonHttpServer } from './daemon/http-server.js';
import { boxLog } from './os/box-log.js';
import { getRunningVersion } from './update/version.js';
import { currentProfile } from './os/profile.js';
import { BOX_CAPABILITIES } from './platform/capabilities.js';
import { describeBoxTokenMode, takeBoxSecrets, type BoxTokenMode } from './platform/box-secrets.js';

export { buildDaemon, wireLedger } from './daemon/build.js';
export type { BuildDaemonOptions, Daemon, DaemonServices } from './daemon/build.js';
export { buildWatchDeliver } from './daemon/wire-harnesses.js';
import { normalizeBasePath } from './daemon/base-path.js';

export { normalizeBasePath, stripPrefix } from './daemon/base-path.js';
// Lives in web-assets.ts with the index.html provider (W1-E); exported from here as before.
export { indexHtmlWithBase } from './web-assets.js';

interface CreateAppOptions {
  db: Database.Database;
  skipPty?: boolean;
  /** The data directory: Doppler token/config files, plugins, keys (defaults to ~/.dispatch). */
  secretsDir?: string;
  /** Directory for bundled CLI tools (defaults to <secretsDir>/tools). */
  toolsDir?: string;
  /** The plugins folder (defaults to <secretsDir>/plugins). */
  pluginsDir?: string;
  /** Model assist for plugins; tests inject a fake, and omit it for none. */
  assistRunner?: AssistRunner | null;
  /** The bundled plugins folder (tests pass a temp one, or omit it for none). */
  bundledDir?: string | null;
  /** Inject a pre-built SecretsService (e.g. with a fake Doppler client) for tests. */
  secretsService?: SecretsService;
  /** Override the structured command (test seam: spawn fake-claude instead of real claude). */
  structuredCommand?: { command: string; args: string[] };
  /** Inject the key registry (tests mint keys through it). Exposed as `app.locals.keys`. */
  keys?: KeyRegistry;
  /** Chat service that the `/api/endless` routes use (a stub in tests). Without it they answer 503: Chat starts only when the daemon listens. */
  endless?: EndlessService;
  /** Test seam: what the `/api/usage-limits` routes read, in place of the services of the build. */
  usageLimits?: ApiRouteDeps['usageLimits'];
  /** Test seam: the accounts the plugin assist route knows. */
  assistAccounts?: ApiRouteDeps['assistAccounts'];
  /**
   * Structured managers by provider name, in place of the real Claude, Codex, Grok and opencode
   * managers (test seam: no CLI runs). Must include `claude-code`.
   */
  managers?: Map<string, IStructuredManager>;
}

/**
 * The test build of the daemon: the same wiring as `startServer`, minus the gate, the network and the timers.
 * Nothing listens, and no thread is told an address.
 */
export function createApp(options: CreateAppOptions): express.Express {
  const { db, skipPty = false, secretsDir, managers, bundledDir, ...seams } = options;
  const { app, services } = buildDaemon({
    ...seams, db, dataDir: secretsDir ?? platform.dataDir(), auth: 'open', network: false, timers: false,
    bundledDir: bundledDir ?? null, pty: skipPty ? new NoopPTYManager() : undefined,
    managers: managers ? Object.fromEntries(managers) : undefined,
  });
  // Internals that some tests read.
  Object.assign(app, { _ptyManager: services.ptyManager, _sessionService: services.sessionService, _pushService: services.pushService, _structuredManager: services.structuredManager });
  return app;
}

/**
 * Take the two box secrets out of the environment and refuse one value in both roles
 * (platform/box-secrets.ts). A local install has neither: nothing changes for it.
 */
function takeBoxSecretsAtStart(): BoxTokenMode {
  const mode = takeBoxSecrets();
  if (mode !== 'local') console.log(`[dispatch] ${describeBoxTokenMode(mode)}`);
  return mode;
}

/** Resolve the user's shell PATH so PTYs inherit it (fixes Finder/login-items launches). */
function adoptLoginPath(): void {
  const shellPath = platform.resolveLoginPath();
  if (shellPath) {
    process.env.PATH = shellPath;
    console.log(`Resolved shell PATH (${shellPath.split(':').length} entries)`);
  }
  try {
    fs.writeFileSync(
      path.join(os.homedir(), '.dispatch', 'path-debug.log'),
      `ts=${new Date().toISOString()}\nSHELL=${process.env.SHELL}\nshellPath=${shellPath}\nprocess.env.PATH=${process.env.PATH}\n`,
    );
  } catch {}
}

export async function startServer(options?: { port?: number; allowRandomPortFallback?: boolean }): Promise<{ port: number; cleanup: () => void; keys: KeyRegistry }> {
  const preferredPort = options?.port ?? 3456;
  // FIRST, before anything is spawned (the PATH probe below starts a shell): no child inherits a box secret.
  const tokenMode = takeBoxSecretsAtStart();
  // DISPATCH_BIND: checked first, so an invalid value stops the start before anything is opened or spawned.
  const bindHost = parseBindHost(process.env.DISPATCH_BIND);
  adoptLoginPath();

  const dataDir = platform.dataDir();
  // Private to the user before anything else is written (network exposure spec 7.14).
  lockDownDataDir(dataDir, [platform.logDir()]);
  const db = createDatabase(path.join(dataDir, 'dispatch.db'));
  sessionsDb.clearStalePids(db, new Set<number>(platform.listProcessIds()));

  // Build: every service and the app (daemon/build.ts). The browser shim points at the daemon's own address.
  const basePath = normalizeBasePath(process.env.DISPATCH_BASE_PATH);
  const shimFor = (port: number) => platform.installBrowserShim({ dataDir, serverUrl: `http://127.0.0.1:${port}${basePath}` });
  const daemon = buildDaemon({ db, dataDir, auth: 'gate', port: preferredPort, shimEnv: shimFor(preferredPort) });
  const { sessionService, keys } = daemon.services;
  // A Claude overseer loads only its own memory folder under this home (overseer memory scope spec 2026-10-07, Unit 1).
  sessionService.setOverseerMemoryHome(os.homedir());
  if (daemon.webDist) console.log(`Serving web client from ${daemon.webDist}${basePath ? ` under ${basePath}` : ''}`);

  // Attach and listen. DISPATCH_BIND unset: every interface, the same call as before. Set: that address only (platform/bind.ts).
  const server = createDaemonHttpServer(daemon.app);
  daemon.attach(server);
  const boundPort = () => (server.address() as AddressInfo | null)?.port ?? preferredPort;
  const port = await new Promise<number>((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EADDRINUSE') return reject(err);
      if (!options?.allowRandomPortFallback) return reject(new Error(`Port ${preferredPort} is already in use`));
      listenOn(server, 0, bindHost, () => resolve(boundPort()));
    });
    listenOn(server, preferredPort, bindHost, () => resolve(boundPort()));
  });
  // Hold 127.0.0.1 and ::1 on the port too, so no other process can take localhost from us
  // (platform/loopback-guard.ts). With DISPATCH_BIND the daemon may hold one of them itself: that one is skipped.
  // The other is still held, because threads, hooks and the CLI call the daemon on 127.0.0.1.
  const boundAddress = bindHost === undefined ? null : ((server.address() as AddressInfo | null)?.address ?? bindHost);
  const loopbackGuards = await guardLoopback(server, port, undefined, boundAddress ? [boundAddress] : []);
  if (boundAddress) console.log(`[dispatch] DISPATCH_BIND: listens on ${boundAddress} and on the loopback addresses only, not on all interfaces.`);
  // Record our own pid so daemon controllers (e.g. WSL's restart()) can find and signal this
  // process without an OS service manager. Only now that the port is bound: a duplicate launch
  // that loses the port race exits above and must not overwrite the live daemon's pid (#56).
  writeOwnPid(dataDir);
  writeListenInfo(dataDir, { port, bind: boundAddress }); // "dispatch status" prints it
  daemon.listening(port, port !== preferredPort ? { shimEnv: shimFor(port) } : undefined);
  console.log(`Dispatch server listening on port ${port}`);
  logDaemonStart(port, basePath, tokenMode);
  if (daemon.services.accessGate) console.log('Network: other devices need the access token (run "dispatch access"). Tailscale devices on your own account are allowed.');

  // Boot recovery does not block the start: it waits a short settle delay before it reads any status.
  void daemon.bootRecover().catch((err) => console.error('boot recovery failed', err));
  daemon.startTimers();

  // Graceful shutdown
  let shuttingDown = false;
  const cleanup = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Shutting down Dispatch server...');
    for (const g of loopbackGuards) g.close();
    daemon.stop(); // the timers, the processes, the sockets and the HTTP server
    db.close(); // SQLite (and the message journal in it) is written synchronously: closing it is the flush
    removeOwnPid(dataDir); // only if still ours: a newer daemon may own the file by now
  };
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, exitAfter(cleanup, sig));
  return { port, cleanup, keys };
}

/** Hosted box log (os/box-log.ts): one line that says which build started, and how. Local: no line. */
function logDaemonStart(port: number, basePath: string, tokenMode: BoxTokenMode): void {
  boxLog('daemon.start', {
    version: getRunningVersion(), profile: currentProfile(), basePath: basePath || '/', capabilities: [...BOX_CAPABILITIES],
    port, node: process.version, tokenMode, ...(process.env.DISPATCH_BOX_ID ? { boxId: process.env.DISPATCH_BOX_ID } : {}),
  });
}

/**
 * The signal handler: clean up, then exit on our own. With a SIGTERM handler installed Node no longer
 * exits by default, and a CLI child, a socket or a timer can keep the loop alive: a box under
 * `docker stop` waited the full timeout and was killed (2026-11-11). The children got SIGTERM in
 * stop(); give them the kill grace (they are SIGKILLed after it), then go. Inside docker's 10 s and ECS's 30 s.
 */
function exitAfter(cleanup: () => void, signal: string): () => void {
  return () => {
    boxLog('daemon.shutdown', { signal, uptimeSec: Math.round(process.uptime()) });
    cleanup();
    setTimeout(() => process.exit(0), KILL_GRACE_MS + 500).unref();
  };
}

// When run directly via tsx src/server.ts
const isDirectRun = process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');
if (isDirectRun) {
  // Log, do not die, on a stray error: an exit kills every live agent thread (see runtime/process-guards.ts).
  installProcessGuards();
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  startServer({ port }).catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
