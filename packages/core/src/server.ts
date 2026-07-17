import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { fileURLToPath } from 'url';
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
import { aggregateSessionStatus } from './status/aggregate.js';
import { AuthRequestService } from './auth/service.js';
import { createAuthRouter } from './routes/auth.js';
import { createProvidersRouter } from './routes/providers.js';
import { createServersRouter } from './routes/servers.js';
import { createFilesRouter } from './routes/files.js';
import { createStateRouter } from './routes/state.js';
import { createGitRouter } from './routes/git.js';
import { createSecretsRouter } from './routes/secrets.js';
import { createTranscribeRouter } from './routes/transcribe.js';
import { TranscriptionService } from './transcription/service.js';
import { createSetupRouter } from './routes/setup.js';
import { createToolsRouter } from './routes/tools.js';
import { getToolsSpawnEnv, toolStatuses, awarenessNote } from './tools/status.js';
import { SecretsService } from './secrets/service.js';
import { IntegrationsService } from './integrations/service.js';
import { createEventsRouter } from './routes/events.js';
import { createIntegrationsRouter } from './routes/integrations.js';
import { PushService } from './push/service.js';
import { wireThreadSettledPush } from './push/notify.js';
import { createPushRouter } from './routes/push.js';
import { StatusService } from './status/service.js';
import { createEventsBroadcaster, createNoopBroadcaster } from './ws/events.js';
import type { EventBroadcaster } from './ws/events.js';
import { handleTerminalConnection } from './ws/terminal.js';
import { handleStructuredConnection } from './ws/structured.js';
import { ClaudeStructuredSessionManager, type IStructuredManager } from './structured/manager.js';
import { CodexStructuredSessionManager } from './structured/codex-manager.js';
import { startPtyTimingLoop } from './sessions/status.js';
import { startAutoArchiveLoop } from './sessions/auto-archive.js';
import { TerminalMonitor } from './terminal-monitor.js';
import { ThreadAutoNamer } from './sessions/thread-auto-namer.js';
import { platform } from './platform/index.js';
import { startUpdateCheckLoop } from './update/checker.js';
import { createUpdateRouter } from './routes/update.js';
import { createAppearanceRouter, customIconHandler } from './routes/appearance.js';

/** Repo root, derived the same way as the webDist fallback below (works from both src/ in dev and dist/ once built, since both sit at the same depth under packages/core). */
function resolveRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
}

interface CreateAppOptions {
  db: Database.Database;
  skipPty?: boolean;
  /** Directory for the Doppler token/config files (defaults to ~/.dispatch). */
  secretsDir?: string;
  /** Directory for bundled CLI tools (defaults to <secretsDir>/tools). */
  toolsDir?: string;
  /** Inject a pre-built SecretsService (e.g. with a fake Doppler client) for tests. */
  secretsService?: SecretsService;
  /** Override the structured command (test seam: spawn fake-claude instead of real claude). */
  structuredCommand?: { command: string; args: string[] };
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

/**
 * Wire the structured-thread "membrane": when an escalating AGENT thread hits a
 * gated tool / AskUserQuestion the manager emits 'permission' (→ needs_input) and,
 * once answered, 'resolved' (→ working). Routing it through StatusService means it
 * broadcasts terminal:status + fires the same push/notify path the PTY/hook flow uses.
 */
function wirePermissionMembrane(structuredManager: IStructuredManager, statusService: StatusService, sessionService: SessionService): void {
  structuredManager.on('permission', (terminalId: string, pending: { toolName?: string; questions?: any[] }) => {
    // An agent's AskUserQuestion escalates UP to its project's coordinator (Dispatch), not to
    // the human. When that routing succeeds the agent stays "working" (it's waiting on the
    // coordinator, an internal handoff) — only un-routable permissions reach the human.
    if (sessionService.routeAgentQuestionToCoordinator(terminalId, pending)) {
      statusService.markWorking(terminalId, 'Asking Control Plane…');
      return;
    }
    const activity = pending?.questions?.length
      ? 'Needs your answer'
      : `Needs approval: ${pending?.toolName ?? 'tool'}`;
    statusService.markNeedsInput(terminalId, activity);
  });
  structuredManager.on('resolved', (terminalId: string) => {
    statusService.markWorking(terminalId, 'Working…');
  });
  // Turn boundaries → accurate status, and the moment an AGENT settles, push an immediate
  // completion notice up to its coordinator (so Dispatch ingests results, not fire-and-forget).
  structuredManager.on('busy', (terminalId: string) => {
    statusService.markWorking(terminalId, 'Working…');
  });
  structuredManager.on('idle', (terminalId: string) => {
    statusService.markIdle(terminalId);
    sessionService.noteAgentCompletion(terminalId);
  });
  // A wake-scheduler tool (ScheduleWakeup/CronCreate) ended the turn deliberately — the
  // thread is dormant, not finished. Deliberately does NOT call noteAgentCompletion: the
  // agent hasn't produced a result for its coordinator yet, it's just asleep until its timer
  // fires and the CLI process resumes on its own.
  structuredManager.on('scheduled', (terminalId: string, activity: string) => {
    statusService.markScheduled(terminalId, activity);
  });
}

/**
 * Codex "Pretty" (structured app-server transport). Enabled after the Phase B live E2E proved a
 * real Codex-Pretty thread streams a turn + surfaces/answers an approval end-to-end (see the
 * CodexStructuredSessionManager). Kill-switch: set DISPATCH_CODEX_PRETTY=0 to fall back to the
 * PTY-only Codex transport (mirrors the web modal's CODEX_PRETTY_ENABLED flag).
 */
const CODEX_PRETTY_ENABLED = process.env.DISPATCH_CODEX_PRETTY !== '0';

/**
 * Wire the Codex app-server structured manager onto the service (so `structuredManagerFor('codex')`
 * resolves it and the Codex Pretty transport comes alive), reusing the SAME permission membrane
 * as Claude — both managers emit the identical Claude-shaped event contract. No-op (returns
 * undefined) when Codex Pretty is disabled; Codex then keeps only its PTY transport.
 */
function wireCodexPretty(sessionService: SessionService, statusService: StatusService): IStructuredManager | undefined {
  if (!CODEX_PRETTY_ENABLED) return undefined;
  const codexManager = new CodexStructuredSessionManager();
  sessionService.setCodexStructuredManager(codexManager);
  wirePermissionMembrane(codexManager, statusService, sessionService);
  return codexManager;
}

export function createApp(options: CreateAppOptions): import('express').Express {
  const { db, skipPty = false } = options;

  const app = express();
  app.use(express.json({ limit: '50mb' })); // large enough for Claude PostToolUse hook payloads (full file reads)

  const ptyManager = skipPty ? new NoopPTYManager() : new PTYManager();
  const serverUrl = 'http://localhost:3456'; // Updated at runtime in startServer

  // For testing, use a no-op broadcaster; in production, wired up in startServer
  const broadcaster: EventBroadcaster = createNoopBroadcaster();
  const authRequestService = new AuthRequestService(broadcaster);

  const dispatchDir = options.secretsDir ?? platform.dataDir();
  const toolsBase = options.toolsDir ?? path.join(dispatchDir, 'tools');
  const sessionService = new SessionService(db, ptyManager, path.join(dispatchDir, 'mcp.json'));
  const agentService = new AgentService(db, sessionService, broadcaster);
  const secretsService = options.secretsService ?? new SecretsService(dispatchDir);
  const integrationsService = new IntegrationsService(db);
  sessionService.setSecretsServerSpec(() => ({ spec: secretsService.getServerSpec(), prompt: secretsService.getSystemPrompt() }));
  sessionService.setIntegrationsSpecs(() => integrationsService.getServerSpecs());
  sessionService.setToolsAwareness(() => awarenessNote(toolStatuses({ base: toolsBase })));
  const structuredManager = new ClaudeStructuredSessionManager();
  sessionService.setStructuredManager(structuredManager);
  if (options.structuredCommand) sessionService.setStructuredCommandOverride(options.structuredCommand);
  const statusService = new StatusService(db, broadcaster);
  wirePermissionMembrane(structuredManager, statusService, sessionService);
  wireCodexPretty(sessionService, statusService);
  const pushService = new PushService(db, { vapidDir: dispatchDir });

  wireThreadSettledPush(db, statusService, pushService);

  // Mount routes
  app.use('/api/sessions', createSessionsRouter(sessionService, broadcaster));
  app.use('/api', createTerminalsRouter(sessionService, undefined, statusService));
  app.use('/api/events', createEventsRouter(statusService));
  app.use('/api/agents', createAgentsRouter(agentService));
  app.use('/api/providers', createProvidersRouter());
  app.use('/api/servers', createServersRouter(db));
  app.use('/api/secrets', createSecretsRouter(secretsService));
  app.use('/api/transcribe', createTranscribeRouter(new TranscriptionService(secretsService)));
  app.use('/api/setup', createSetupRouter(db, secretsService));
  app.use('/api/sessions/:id/files', createFilesRouter(db));
  app.use('/api/sessions/:id/git', createGitRouter(db));
  app.use('/api/auth-requests', createAuthRouter(authRequestService));
  app.use('/api/state', createStateRouter(db));
  app.use('/api/integrations', createIntegrationsRouter(integrationsService));
  app.use('/api/push', createPushRouter(pushService));
  app.use('/api/tools', createToolsRouter({ base: toolsBase }));
  app.use('/api/update', createUpdateRouter(broadcaster, resolveRepoRoot(), db));
  app.use('/api/appearance', createAppearanceRouter(dispatchDir));

  // Attach internals for server wiring
  (app as any)._ptyManager = ptyManager;
  (app as any)._sessionService = sessionService;
  (app as any)._pushService = pushService;
  (app as any)._structuredManager = structuredManager;

  // Serve the built web client (single-origin) when a build is present.
  // SPA fallback returns index.html for any non-/api, non-WS GET.
  const webDist = process.env.DISPATCH_WEB_DIST
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.get('/icons/:name', customIconHandler(dispatchDir));
    app.use(express.static(webDist));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  return app;
}

export async function startServer(options?: { port?: number; allowRandomPortFallback?: boolean }): Promise<{ port: number; cleanup: () => void }> {
  const preferredPort = options?.port ?? 3456;

  // Resolve the user's shell PATH so PTYs inherit it (fixes Finder/login-items launches)
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

  // Ensure data directory exists
  const dataDir = platform.dataDir();
  fs.mkdirSync(dataDir, { recursive: true });

  // Record our own pid so daemon controllers (e.g. WSL's restart()) can find and
  // signal this process without depending on the OS service manager for tracking.
  fs.writeFileSync(path.join(dataDir, 'daemon.pid'), String(process.pid));

  const browserShimEnv = platform.installBrowserShim({
    dataDir,
    serverUrl: `http://127.0.0.1:${preferredPort}`,
  });

  // Create database
  const dbPath = path.join(dataDir, 'dispatch.db');
  const db = createDatabase(dbPath);

  // Create PTY manager
  const ptyManager = new PTYManager(browserShimEnv);

  // Clean stale PIDs
  const alivePids = new Set<number>(platform.listProcessIds());
  sessionsDb.clearStalePids(db, alivePids);

  // Create Express app
  const app = express();
  app.use(express.json({ limit: '50mb' })); // large enough for Claude PostToolUse hook payloads (full file reads)

  // Create HTTP server
  const server = http.createServer(app);

  // Create WebSocket servers (noServer mode)
  const eventsWss = new WebSocketServer({ noServer: true });
  const terminalWss = new WebSocketServer({ noServer: true });
  const structuredWss = new WebSocketServer({ noServer: true });

  // Keepalive: Cloudflare drops idle proxied WebSockets at ~100s. Ping clients
  // every 30s so terminal/events sockets survive quiet periods through the tunnel.
  const heartbeat = setInterval(() => {
    for (const wss of [eventsWss, terminalWss, structuredWss]) {
      for (const client of wss.clients) {
        if (client.readyState === client.OPEN) client.ping();
      }
    }
  }, 30_000);

  // Create broadcaster
  const broadcaster = createEventsBroadcaster(eventsWss);
  const authRequestService = new AuthRequestService(broadcaster);

  // Debounced, best-effort thread auto-namer — fed by real-activity signals from
  // StatusService (hook events) and TerminalMonitor (PTY busy/idle), below. Uses the
  // real (websocket-wired) broadcaster so a successful rename's `session:tabs-changed`
  // reaches connected clients the same way a user rename does today.
  const threadAutoNamer = new ThreadAutoNamer(db, broadcaster);

  // Determine actual server URL after port is known
  const sessionService = new SessionService(db, ptyManager, path.join(dataDir, 'mcp.json'));
  const agentService = new AgentService(db, sessionService, broadcaster, path.join(dataDir, 'runs'));
  const statusService = new StatusService(db, broadcaster, (id) => threadAutoNamer.notifyActivity(id));
  const structuredManager = new ClaudeStructuredSessionManager();
  sessionService.setStructuredManager(structuredManager);
  wirePermissionMembrane(structuredManager, statusService, sessionService);
  wireCodexPretty(sessionService, statusService);
  const pushService = new PushService(db, { vapidDir: dataDir });

  wireThreadSettledPush(db, statusService, pushService);

  // Doppler secrets: token-backed connection + per-spawn injection (DOPPLER_* env +
  // an MCP server) so Claude Code / Codex agents can add & retrieve secrets.
  const secretsService = new SecretsService(dataDir);
  const integrationsService = new IntegrationsService(db);
  const toolsBase = path.join(dataDir, 'tools');
  sessionService.setSecretsServerSpec(() => ({ spec: secretsService.getServerSpec(), prompt: secretsService.getSystemPrompt() }));
  sessionService.setIntegrationsSpecs(() => integrationsService.getServerSpecs());
  sessionService.setToolsAwareness(() => awarenessNote(toolStatuses({ base: toolsBase })));
  let effectiveShimEnv = browserShimEnv;
  const refreshPtyEnv = () => {
    const spawnEnv = { ...effectiveShimEnv, ...secretsService.getSpawnEnv(), ...getToolsSpawnEnv({ base: toolsBase }) };
    ptyManager.setDefaultEnv(spawnEnv);
    structuredManager.setDefaultEnv(spawnEnv);
  };
  secretsService.onChange(refreshPtyEnv);
  refreshPtyEnv();

  // Terminal activity monitor — parses status bar, detects busy/idle
  const terminalMonitor = new TerminalMonitor(broadcaster, db, (terminalId, activity) => {
    agentService.updateRunFromTerminalActivity(terminalId, activity);
  }, (id) => threadAutoNamer.notifyActivity(id));

  // Wire PTY data through the monitor (busy/idle + status-bar HUD) and, for
  // autonomous agent-runner terminals, through the structured stream parser
  // (live steps + transcript capture + outcome telemetry).
  ptyManager.on('data', (id: string, data: Buffer) => {
    terminalMonitor.onOutput(id, data);
    agentService.onRunnerData(id, data);
  });

  function rollupSession(sessionId: string) {
    const status = aggregateSessionStatus(terminalsDb.listBySession(db, sessionId).map((t) => t.status || 'waiting'));
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
      rollupSession(terminal.session_id);
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

  // Mirror the PTY exit handler for structured-transport terminals
  structuredManager.on('exit', (id: string, _exitCode: number) => {
    if (!db.open) return;
    const terminal = terminalsDb.getById(db, id);
    if (terminal) {
      terminalsDb.updatePid(db, id, null);
      terminalsDb.updateStatus(db, id, 'waiting');
      broadcaster.broadcast({ type: 'terminal:status', terminalId: id, status: 'waiting' });
      broadcaster.broadcast({ type: 'terminal:exit', terminalId: id, sessionId: terminal.session_id });
      sessionsDb.updatePid(db, terminal.session_id, null);
      rollupSession(terminal.session_id);
    }
  });

  // Mount routes
  app.use('/api/sessions', createSessionsRouter(sessionService, broadcaster));
  app.use('/api', createTerminalsRouter(sessionService, broadcaster, statusService));
  app.use('/api/events', createEventsRouter(statusService));
  app.use('/api/agents', createAgentsRouter(agentService));
  app.use('/api/providers', createProvidersRouter());
  app.use('/api/servers', createServersRouter(db));
  app.use('/api/secrets', createSecretsRouter(secretsService));
  app.use('/api/transcribe', createTranscribeRouter(new TranscriptionService(secretsService)));
  app.use('/api/setup', createSetupRouter(db, secretsService));
  app.use('/api/sessions/:id/files', createFilesRouter(db));
  app.use('/api/sessions/:id/git', createGitRouter(db));
  app.use('/api/auth-requests', createAuthRouter(authRequestService));

  app.use('/api/state', createStateRouter(db));
  app.use('/api/integrations', createIntegrationsRouter(integrationsService));
  app.use('/api/push', createPushRouter(pushService));
  app.use('/api/tools', createToolsRouter({ base: toolsBase }));
  const repoRoot = resolveRepoRoot();
  app.use('/api/update', createUpdateRouter(broadcaster, repoRoot, db));
  app.use('/api/appearance', createAppearanceRouter(dataDir));

  // Serve the built web client (single-origin) when a build is present.
  // SPA fallback returns index.html for any non-/api, non-WS GET.
  const webDist = process.env.DISPATCH_WEB_DIST
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.get('/icons/:name', customIconHandler(dataDir));
    app.use(express.static(webDist));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
    console.log(`Serving web client from ${webDist}`);
  }

  // Handle HTTP upgrade for WebSocket connections
  server.on('upgrade', (request, socket, head) => {
    const url = request.url || '';

    if (url.match(/\/api\/terminals\/[^/]+\/structured-ws/)) {
      structuredWss.handleUpgrade(request, socket, head, (ws) => {
        // Pick the RIGHT manager for this terminal's harness (claude stream-json vs codex
        // app-server) — both satisfy IStructuredManager, so the ws handler is transport-agnostic.
        // Falls back to the Claude manager when the terminal/type can't be resolved yet.
        const id = url.match(/\/api\/terminals\/([^/]+)\/structured-ws/)?.[1];
        const manager = (id && sessionService.structuredManagerForTerminal(id)) || structuredManager;
        handleStructuredConnection(ws, request, manager, (tid) => sessionService.ensureStructuredAlive(tid));
      });
    } else if (url.match(/\/api\/terminals\/[^/]+\/ws/) || url.match(/\/api\/sessions\/[^/]+\/terminal/)) {
      terminalWss.handleUpgrade(request, socket, head, (ws) => {
        handleTerminalConnection(ws, request, ptyManager, sessionService, terminalMonitor);
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
    effectiveShimEnv = platform.installBrowserShim({
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

  // Boot recovery: auto-resume overseer threads (coordinator + typed agents) that
  // the previous shutdown interrupted mid-turn. Fire-and-forget — it waits a short
  // settle delay before reading status, so it must not block startup.
  void sessionService.kickstartInterruptedAgents()
    .then(({ kicked, skipped }) => {
      if (kicked.length) console.log(`Kickstart: resumed ${kicked.length} interrupted thread(s); skipped ${skipped.length}`);
    })
    .catch((err) => console.error('kickstart failed', err));

  // Start PTY timing loop for Codex-style providers
  const ptyTimingInterval = startPtyTimingLoop(db, ptyManager, broadcaster);
  // Poll GitHub Releases for a newer version than what's running (immediately, then ~45 min)
  const updateCheckInterval = startUpdateCheckLoop(db, broadcaster);
  const agentSchedulerInterval = setInterval(() => {
    try {
      agentService.processDueRuns();
    } catch (err) {
      console.error(err);
    }
  }, 30_000);

  // Auto-archive sweep — prunes opted-in threads that have gone idle past their
  // deadline. Cheap: a full scan of a small table (terminals) once a minute — no
  // index backs this, but the table stays small enough that it doesn't matter.
  const autoArchiveInterval = startAutoArchiveLoop(db, sessionService, broadcaster);

  // Graceful shutdown
  const cleanup = () => {
    console.log('Shutting down Dispatch server...');
    clearInterval(ptyTimingInterval);
    clearInterval(updateCheckInterval);
    clearInterval(agentSchedulerInterval);
    clearInterval(autoArchiveInterval);
    clearInterval(heartbeat);
    threadAutoNamer.dispose();
    ptyManager.killAll();
    structuredManager.killAll();
    eventsWss.close();
    terminalWss.close();
    structuredWss.close();
    server.close();
    db.close();
    try { fs.unlinkSync(path.join(dataDir, 'daemon.pid')); } catch {}
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
