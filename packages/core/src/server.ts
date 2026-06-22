import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { fileURLToPath } from 'url';
import { execFileSync, execSync } from 'child_process';
import express from 'express';
import { WebSocketServer } from 'ws';
import type Database from 'better-sqlite3';
import { createDatabase } from './db/connection.js';
import * as sessionsDb from './db/sessions.js';
import * as terminalsDb from './db/terminals.js';
import * as appState from './db/app-state.js';
import { SessionService } from './sessions/service.js';
import { PTYManager } from './pty/manager.js';
import { createSessionsRouter } from './routes/sessions.js';
import { createTerminalsRouter } from './routes/terminals.js';
import { AgentService } from './agents/service.js';
import { createAgentsRouter } from './routes/agents.js';
import { createHooksRouter } from './routes/hooks.js';
import { AuthRequestService } from './auth/service.js';
import { installBrowserShim } from './auth/shim.js';

import { createAuthRouter } from './routes/auth.js';
import { createProvidersRouter } from './routes/providers.js';
import { createServersRouter } from './routes/servers.js';
import { createFilesRouter } from './routes/files.js';
import { createStateRouter } from './routes/state.js';
import { createGitRouter } from './routes/git.js';
import { createSecretsRouter } from './routes/secrets.js';
import { SecretsService } from './secrets/service.js';
import { createEventsRouter } from './routes/events.js';
import { StatusService } from './status/service.js';
import { createEventsBroadcaster, createNoopBroadcaster } from './ws/events.js';
import type { EventBroadcaster } from './ws/events.js';
import { handleTerminalConnection } from './ws/terminal.js';
import { startPtyTimingLoop } from './sessions/status.js';
import { TerminalMonitor } from './terminal-monitor.js';

interface CreateAppOptions {
  db: Database.Database;
  skipPty?: boolean;
  /** Directory for the Doppler token/config files (defaults to ~/.dispatch). */
  secretsDir?: string;
  /** Inject a pre-built SecretsService (e.g. with a fake Doppler client) for tests. */
  secretsService?: SecretsService;
}

/**
 * A no-op PTY manager for testing. Spawn always fails gracefully
 * (session records the error and moves to 'done' status).
 */
class NoopPTYManager extends PTYManager {
  private nextPid = 1000;
  private alive = new Set<string>();

  override spawn(sessionId: string): number {
    this.alive.add(sessionId);
    return this.nextPid++;
  }
  override write(): void {}
  override resize(): void {}
  override kill(sessionId: string): void { this.alive.delete(sessionId); }
  override getBuffer(): string { return ''; }
  override getLastActivity(): Date | null { return null; }
  override isAlive(sessionId: string): boolean { return this.alive.has(sessionId); }
  override killAll(): void { this.alive.clear(); }
}

export function createApp(options: CreateAppOptions): import('express').Express {
  const { db, skipPty = false } = options;

  const app = express();
  app.use(express.json());

  const ptyManager = skipPty ? new NoopPTYManager() : new PTYManager();
  const serverUrl = 'http://localhost:3456'; // Updated at runtime in startServer

  // For testing, use a no-op broadcaster; in production, wired up in startServer
  const broadcaster: EventBroadcaster = createNoopBroadcaster();
  const authRequestService = new AuthRequestService(broadcaster);

  const sessionService = new SessionService(db, ptyManager);
  const agentService = new AgentService(db, sessionService, broadcaster);
  const secretsService = options.secretsService ?? new SecretsService(options.secretsDir ?? path.join(os.homedir(), '.dispatch'));
  sessionService.setSecretsInjection(() => secretsService.getInjection());
  const statusService = new StatusService(db, broadcaster);

  // Mount routes
  app.use('/api/sessions', createSessionsRouter(sessionService, broadcaster));
  app.use('/api', createTerminalsRouter(sessionService, undefined, statusService));
  app.use('/api/events', createEventsRouter(statusService));
  app.use('/api/agents', createAgentsRouter(agentService));
  app.use('/api/hooks', createHooksRouter(db, broadcaster));
  app.use('/api/providers', createProvidersRouter());
  app.use('/api/servers', createServersRouter(db));
  app.use('/api/secrets', createSecretsRouter(secretsService));
  app.use('/api/sessions/:id/files', createFilesRouter(db));
  app.use('/api/sessions/:id/git', createGitRouter(db));
  app.use('/api/auth-requests', createAuthRouter(authRequestService));
  app.use('/api/state', createStateRouter(db));

  // Attach internals for server wiring
  (app as any)._ptyManager = ptyManager;
  (app as any)._sessionService = sessionService;

  // Serve the built web client (single-origin) when a build is present.
  // SPA fallback returns index.html for any non-/api, non-WS GET.
  const webDist = process.env.DISPATCH_WEB_DIST
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  return app;
}

/**
 * When launched from Finder/Login Items, macOS GUI apps inherit launchd's
 * minimal PATH (no ~/.local/bin, no nvm, no homebrew). Ask the user's login
 * shell for its PATH so spawned PTYs can find `claude`, `codex`, git, etc.
 */
function resolveShellPath(): string | undefined {
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    // Wrap PATH in sentinels so we can extract it cleanly even if .zshrc prints noise
    // (e.g. "Restored session:" lines, p10k hints, shell integration prints).
    const out = execFileSync(
      shell,
      ['-ilc', 'echo -n "__DISPATCH_PATH_START__${PATH}__DISPATCH_PATH_END__"'],
      { encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const match = String(out).match(/__DISPATCH_PATH_START__(.*?)__DISPATCH_PATH_END__/s);
    const resolved = match?.[1]?.trim();
    return resolved && resolved.length > 0 ? resolved : undefined;
  } catch {
    return undefined;
  }
}

export async function startServer(options?: { port?: number; allowRandomPortFallback?: boolean }): Promise<{ port: number; cleanup: () => void }> {
  const preferredPort = options?.port ?? 3456;

  // Resolve the user's shell PATH so PTYs inherit it (fixes Finder/login-items launches)
  const shellPath = resolveShellPath();
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

  // Ensure data directory exists
  const dataDir = path.join(os.homedir(), '.dispatch');
  fs.mkdirSync(dataDir, { recursive: true });

  const browserShimEnv = installBrowserShim({
    dataDir,
    serverUrl: `http://127.0.0.1:${preferredPort}`,
  });

  // Create database
  const dbPath = path.join(dataDir, 'dispatch.db');
  const db = createDatabase(dbPath);

  // Create PTY manager
  const ptyManager = new PTYManager(browserShimEnv);

  // Clean stale PIDs
  const alivePids = new Set<number>();
  try {
    const procs = execSync('ps -eo pid', { encoding: 'utf-8' });
    for (const line of procs.split('\n')) {
      const pid = parseInt(line.trim(), 10);
      if (!isNaN(pid)) alivePids.add(pid);
    }
  } catch {}
  sessionsDb.clearStalePids(db, alivePids);

  // Create Express app
  const app = express();
  app.use(express.json());

  // Create HTTP server
  const server = http.createServer(app);

  // Create WebSocket servers (noServer mode)
  const eventsWss = new WebSocketServer({ noServer: true });
  const terminalWss = new WebSocketServer({ noServer: true });

  // Keepalive: Cloudflare drops idle proxied WebSockets at ~100s. Ping clients
  // every 30s so terminal/events sockets survive quiet periods through the tunnel.
  const heartbeat = setInterval(() => {
    for (const wss of [eventsWss, terminalWss]) {
      for (const client of wss.clients) {
        if (client.readyState === client.OPEN) client.ping();
      }
    }
  }, 30_000);

  // Create broadcaster
  const broadcaster = createEventsBroadcaster(eventsWss);
  const authRequestService = new AuthRequestService(broadcaster);

  // Determine actual server URL after port is known
  const sessionService = new SessionService(db, ptyManager);
  const agentService = new AgentService(db, sessionService, broadcaster, path.join(dataDir, 'runs'));
  const statusService = new StatusService(db, broadcaster);

  // Doppler secrets: token-backed connection + per-spawn injection (DOPPLER_* env +
  // an MCP server) so Claude Code / Codex agents can add & retrieve secrets.
  const secretsService = new SecretsService(dataDir);
  sessionService.setSecretsInjection(() => secretsService.getInjection());
  let effectiveShimEnv = browserShimEnv;
  const refreshPtyEnv = () => ptyManager.setDefaultEnv({ ...effectiveShimEnv, ...secretsService.getSpawnEnv() });
  secretsService.onChange(refreshPtyEnv);
  refreshPtyEnv();

  // Terminal activity monitor — parses status bar, detects busy/idle
  const terminalMonitor = new TerminalMonitor(broadcaster, db, (terminalId, activity) => {
    agentService.updateRunFromTerminalActivity(terminalId, activity);
  });

  // Wire PTY data through the monitor (busy/idle + status-bar HUD) and, for
  // autonomous agent-runner terminals, through the structured stream parser
  // (live steps + transcript capture + outcome telemetry).
  ptyManager.on('data', (id: string, data: Buffer) => {
    terminalMonitor.onOutput(id, data);
    agentService.onRunnerData(id, data);
  });

  function aggregateSessionStatus(sessionId: string) {
    const allTerminals = terminalsDb.listBySession(db, sessionId);
    let status = 'waiting';
    for (const t of allTerminals) {
      const s = t.status || 'waiting';
      if (s === 'needs_input') { status = 'needs_input'; break; }
    }
    sessionsDb.updateStatus(db, sessionId, status);
    broadcaster.broadcast({ type: 'session:status', sessionId, status });
  }

  // When a PTY exits, clean up monitor and update status
  ptyManager.on('exit', (id: string, exitCode: number) => {
    terminalMonitor.remove(id);
    // During shutdown the DB is closed before node-pty's async exit events fire;
    // skip the DB work to avoid "database connection is not open" crashes.
    if (!db.open) return;
    // Check if this ID is a terminal
    const terminal = terminalsDb.getById(db, id);
    if (terminal) {
      terminalsDb.updatePid(db, id, null);
      terminalsDb.updateStatus(db, id, 'waiting');
      broadcaster.broadcast({ type: 'terminal:status', terminalId: id, status: 'waiting' });
      broadcaster.broadcast({ type: 'terminal:exit', terminalId: id, sessionId: terminal.session_id });
      sessionsDb.updatePid(db, terminal.session_id, null);
      aggregateSessionStatus(terminal.session_id);
    } else {
      // Legacy: id is a session ID
      sessionsDb.updateStatus(db, id, 'waiting');
      sessionsDb.updatePid(db, id, null);
      broadcaster.broadcast({ type: 'session:status', sessionId: id, status: 'waiting' });
    }

    // If this terminal was backing an autonomous agent run, finalize the run:
    // exit 0 -> succeeded, non-zero -> failed.
    try {
      agentService.handleTerminalExit(id, exitCode);
    } catch (err) {
      console.error('agent run exit handler failed', err);
    }
  });

  // Mount routes
  app.use('/api/sessions', createSessionsRouter(sessionService, broadcaster));
  app.use('/api', createTerminalsRouter(sessionService, broadcaster, statusService));
  app.use('/api/events', createEventsRouter(statusService));
  app.use('/api/agents', createAgentsRouter(agentService));
  app.use('/api/hooks', createHooksRouter(db, broadcaster));
  app.use('/api/providers', createProvidersRouter());
  app.use('/api/servers', createServersRouter(db));
  app.use('/api/secrets', createSecretsRouter(secretsService));
  app.use('/api/sessions/:id/files', createFilesRouter(db));
  app.use('/api/sessions/:id/git', createGitRouter(db));
  app.use('/api/auth-requests', createAuthRouter(authRequestService));

  app.use('/api/state', createStateRouter(db));

  // Serve the built web client (single-origin) when a build is present.
  // SPA fallback returns index.html for any non-/api, non-WS GET.
  const webDist = process.env.DISPATCH_WEB_DIST
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
    console.log(`Serving web client from ${webDist}`);
  }

  // Handle HTTP upgrade for WebSocket connections
  server.on('upgrade', (request, socket, head) => {
    const url = request.url || '';

    if (url.match(/\/api\/terminals\/[^/]+\/ws/) || url.match(/\/api\/sessions\/[^/]+\/terminal/)) {
      terminalWss.handleUpgrade(request, socket, head, (ws) => {
        handleTerminalConnection(ws, request, ptyManager, sessionService);
      });
    } else if (url === '/api/events') {
      eventsWss.handleUpgrade(request, socket, head, (ws) => {
        eventsWss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // Listen on the port
  const port = await new Promise<number>((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        if (options?.allowRandomPortFallback) {
          server.listen(0, () => {
            const addr = server.address();
            resolve(typeof addr === 'object' && addr ? addr.port : preferredPort);
          });
          return;
        }
        reject(new Error(`Port ${preferredPort} is already in use`));
      } else {
        reject(err);
      }
    });

    server.listen(preferredPort, () => {
      resolve(preferredPort);
    });
  });

  if (port !== preferredPort) {
    effectiveShimEnv = installBrowserShim({
      dataDir,
      serverUrl: `http://127.0.0.1:${port}`,
    });
    refreshPtyEnv();
  }

  // Store port in app state
  appState.set(db, 'port', String(port));

  // Status hooks: tell SessionService how to make spawned agents phone home with
  // lifecycle events (Claude hooks settings file + Codex notify helper).
  sessionService.setStatusContext({
    serverUrl: `http://127.0.0.1:${port}`,
    hooksDir: path.join(dataDir, 'hooks'),
    codexHelperPath: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/codex-notify.mjs'),
  });

  console.log(`Dispatch server listening on port ${port}`);

  // Start PTY timing loop for Codex-style providers
  const ptyTimingInterval = startPtyTimingLoop(db, ptyManager, broadcaster);
  const agentSchedulerInterval = setInterval(() => {
    try {
      agentService.processDueRuns();
    } catch (err) {
      console.error(err);
    }
  }, 30_000);

  // Graceful shutdown
  const cleanup = () => {
    console.log('Shutting down Dispatch server...');
    clearInterval(ptyTimingInterval);
    clearInterval(agentSchedulerInterval);
    clearInterval(heartbeat);
    ptyManager.killAll();
    eventsWss.close();
    terminalWss.close();
    server.close();
    db.close();
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  return { port, cleanup };
}

// When run directly via tsx src/server.ts
const isDirectRun = process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');
if (isDirectRun) {
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  startServer({ port }).catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
