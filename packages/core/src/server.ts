import { subscribeHarnessEvents } from './runtime/adapter.js';
import { listProviders } from './providers/registry.js';
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
import { RolesService } from './roles/service.js';
import { createRolesRouter } from './routes/roles.js';
import { aggregateSessionStatus } from './status/aggregate.js';
import { AuthRequestService } from './auth/service.js';
import { createAuthRouter } from './routes/auth.js';
import { ClaudeLoginService } from './auth/claude-login.js';
import { requireBoxToken, upgradeAllowed } from './auth/box-token.js';
import { OsConnectionsProvider } from './integrations/os-provider.js';
import { HeartbeatService } from './platform/heartbeat.js';
import { UsageRecorder } from './usage/recorder.js';
import { createClaudeAuthRouter } from './routes/claude-auth.js';
import { createProvidersRouter } from './routes/providers.js';
import { createServersRouter } from './routes/servers.js';
import { createFilesRouter } from './routes/files.js';
import { createStateRouter } from './routes/state.js';
import { closeInterruptedTurns } from './analytics/recorder.js';
import { attachPtyCapture } from './analytics/pty-capture.js';
import * as usageDb from './db/usage.js';
import { createGitRouter } from './routes/git.js';
import { createSecretsRouter } from './routes/secrets.js';
import { createHarnessSettingsRouter } from './routes/harness-settings.js';
import { opencodeKeySecretName } from './settings/harness-settings.js';
import { createTranscribeRouter } from './routes/transcribe.js';
import { TranscriptionService } from './transcription/service.js';
import { createSetupRouter } from './routes/setup.js';
import { withShimPath } from './auth/shim.js';
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
import { GrokStructuredSessionManager } from './structured/grok-manager.js';
import { startPtyTimingLoop } from './sessions/status.js';
import { startAutoArchiveLoop } from './sessions/auto-archive.js';
import { TerminalMonitor } from './terminal-monitor.js';
import { ThreadAutoNamer } from './sessions/thread-auto-namer.js';
import { platform } from './platform/index.js';
import { startUpdateCheckLoop } from './update/checker.js';
import { createUpdateRouter } from './routes/update.js';
import { createAppearanceRouter, customIconHandler } from './routes/appearance.js';
import { createWatchesRouter } from './routes/watches.js';
import { WatchDispatcher } from './sessions/watch-dispatcher.js';
import { createAnalyticsRouter, trackingStartedAt } from './routes/analytics.js';

/**
 * The analytics boot steps, run once per app before any route is mounted.
 *
 * `trackingStartedAt` belongs HERE, not on the first request to /api/analytics:
 * stamped lazily on first read, it would record "the first time someone opened
 * the Analytics view", not the instant recording actually began.
 *
 * createApp and startServer both call this, so the two app builders cannot drift.
 */
function bootAnalytics(db: Database.Database): void {
  // A daemon that died mid-turn left rows open; close them before anything reads them.
  closeInterruptedTurns(db);
  // The history importer was removed by decision: analytics is live recording
  // from the tracking start and nothing else. An install that used the old
  // Import button still holds message-grain rows that would mix units into
  // every turn count forever — and the remove control is gone too, so boot is
  // the only place left that can honor the decision. Idempotent; a no-op sweep
  // costs one indexed statement.
  usageDb.deleteBackfilled(db);
  // Stamp the recording start at the instant recording begins. Written once;
  // every later boot reads back the original value.
  trackingStartedAt(db);
}

/**
 * Subscribe PTY usage capture to explicit turn boundaries.
 *
 * `isStructured` is the double-count gate and the reason this is a function rather
 * than an inline literal. It must go through `SessionService.isStructuredTerminal`,
 * which checks BOTH `config.transport === 'structured'` AND a registered manager for
 * the type — a `transport: 'structured'` Codex row is still a PTY thread when
 * Codex-Pretty is off. Re-implementing it as a config read in one builder and not
 * the other would silently roughly double that builder's numbers.
 *
 * createApp and startServer both call this, so the two app builders cannot drift.
 */
function wirePtyUsageCapture(
  db: Database.Database,
  statusService: StatusService,
  sessionService: SessionService,
  broadcaster: EventBroadcaster,
): void {
  statusService.addTurnBoundaryListener(attachPtyCapture({
    db,
    isStructured: (terminalId) => {
      const t = terminalsDb.getById(db, terminalId);
      return !!t && sessionService.isStructuredTerminal(t);
    },
    onTurnClosed: () => broadcaster.broadcast({ type: 'analytics-dirty' }),
  }));
}

/** Repo root, derived the same way as the webDist fallback below (works from both src/ in dev and dist/ once built, since both sit at the same depth under packages/core). */
function resolveRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
}

/**
 * Mount prefix for the whole app (API + WebSockets + web bundle). '' for a local
 * daemon at the origin root; '/u/<slug>/dispatch' for a hosted box, so the whole
 * fleet lives behind ONE origin and one Cloudflare Access application.
 * Normalized to a leading slash and no trailing slash, or '' when unset.
 */
export function normalizeBasePath(raw: string | undefined): string {
  const v = (raw ?? '').trim();
  if (!v || v === '/') return '';
  return ('/' + v.replace(/^\/+/, '').replace(/\/+$/, ''));
}

const BASE_PATH = normalizeBasePath(process.env.DISPATCH_BASE_PATH);
/** Shared secret the router injects on every request to a hosted box. Unset ⇒ open (local). */
const BOX_TOKEN = process.env.DISPATCH_BOX_TOKEN?.trim() || undefined;

/**
 * Serve index.html with `<base href>` rewritten to the mount prefix. That one tag is
 * the single source of truth: Vite builds assets with `base: './'` so they resolve
 * against it, and the client reads `document.baseURI` for its API/WebSocket prefix
 * (web/src/lib/basePath.ts). Rewriting at SERVE time — not build time — is what lets
 * one image serve every user's prefix.
 */
export function indexHtmlWithBase(html: string, basePath: string): string {
  return html.replace(/<base href="[^"]*"\s*\/?>/, `<base href="${basePath || ''}/">`);
}

/**
 * Remove the mount prefix from a URL path, or null when it doesn't carry the prefix.
 * Exact prefix (`/u/x/dispatch`) maps to '/'. A path that merely *starts with* the
 * same characters (`/u/x/dispatchfoo`) is NOT a match — it must be followed by '/'
 * or end there.
 */
export function stripPrefix(url: string, basePath: string): string | null {
  if (!basePath) return url;
  if (url === basePath) return '/';
  if (url.startsWith(basePath + '/') || url.startsWith(basePath + '?')) {
    const rest = url.slice(basePath.length);
    return rest.startsWith('/') ? rest : '/' + rest;
  }
  return null;
}

/** Express middleware form of stripPrefix; 404s anything outside the mount point. */
function stripBasePath(basePath: string): express.RequestHandler {
  return (req, res, next) => {
    const stripped = stripPrefix(req.url, basePath);
    if (stripped === null) {
      res.status(404).end();
      return;
    }
    req.url = stripped;
    next();
  };
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
  override getBufferSize(): number { return 0; }
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
function wirePermissionMembrane(manager: IStructuredManager, status: StatusService, sessions: SessionService, db: Database.Database, _broadcaster: EventBroadcaster): void {
  subscribeHarnessEvents(manager, id => db.open ? terminalsDb.getById(db, id)?.type : undefined, event => status.accept(event, committed => {
    const id = committed.terminalId;
    if (committed.type === 'permission.requested') {
      if (sessions.routeAgentQuestionToCoordinator(id, { toolName: committed.toolName, questions: committed.questions })) status.markWorking(id, 'Asking Control Plane…');
    } else if (committed.type === 'turn.completed') {
      const detail = committed.detail;
      if (committed.outcome === 'idle') {
        const summary = 'summary' in detail ? detail.summary ?? '' : sessions.lastAssistantTextPublic(id);
        sessions.noteTurnOutcome(id, { summary, needsHelp: false, inferred: !detail.declared, state: detail.state, blocker: detail.blocker });
        sessions.noteAgentCompletion(id);
      } else if (committed.outcome === 'needs_help') {
        sessions.noteTurnOutcome(id, { summary: detail.summary ?? '', needsHelp: true, inferred: !!detail.inferred });
        sessions.noteAgentNeedsHelp(id, detail.ask ?? 'Needs your input');
      }
    }
  }));
}

/** Every additional harness receives identical registration, lifecycle and accounting wiring. */
function wireHarnesses(sessionService: SessionService, status: StatusService, db: Database.Database, broadcaster: EventBroadcaster): Map<string, IStructuredManager> {
  const managers = new Map<string, IStructuredManager>();
  for (const provider of listProviders()) {
    if (provider.structured.disabledBy && process.env[provider.structured.disabledBy] === '0') continue;
    const manager = provider.structured.protocol === 'claude-json' ? new ClaudeStructuredSessionManager()
      : provider.structured.protocol === 'acp' ? new GrokStructuredSessionManager(provider.structured.dialect)
      : new CodexStructuredSessionManager();
    sessionService.registerStructuredManager(provider.name, manager);
    wirePermissionMembrane(manager, status, sessionService, db, broadcaster);
    managers.set(provider.name, manager);
  }
  return managers;
}

/**
 * Builds the WatchDispatcher's `deliver` function: picks transport per target the SAME way
 * spawnTerminal/ensureStructuredAlive already do — `config.transport === 'structured'` AND a
 * structured manager exists for that harness. Structured threads get `ensureStructuredAlive`
 * (lazily resumes a dead one) + `sendStructuredMessage`; everything else (PTY threads —
 * claude-code/codex still on the CLI transport, or shell) gets a raw `writeToTerminal` line,
 * exactly as a user's own typed input would arrive.
 */
function buildWatchDeliver(sessionService: SessionService): (terminalId: string, text: string) => void {
  return (terminalId: string, text: string) => {
    const terminal = sessionService.getTerminal(terminalId);
    if (!terminal) return; // watcher vanished between lookup and delivery — nothing to do
    if (terminal.config?.transport === 'structured' && sessionService.structuredManagerFor(terminal.type)) {
      sessionService.ensureStructuredAlive(terminalId);
      sessionService.sendStructuredMessage(terminalId, text);
    } else {
      sessionService.writeToTerminal(terminalId, text + '\n');
    }
  };
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
  // Built ahead of rolesService (moved up from below) so it can be handed in as
  // RolesService's optional push dep — backs the 2-consecutive-failed-nights
  // auto-disable Needs-you (Task 7).
  const pushService = new PushService(db, { vapidDir: dispatchDir });
  const rolesService = new RolesService({ db, agentService, sessionService, pushService });
  agentService.setRoleRunner(rolesService);
  const secretsService = options.secretsService ?? new SecretsService(dispatchDir);
  const integrationsService = new IntegrationsService(db);
  sessionService.setSecretsServerSpec(() => ({ spec: secretsService.getServerSpec(), prompt: secretsService.getSystemPrompt() }));
  sessionService.setIntegrationsSpecs(() => integrationsService.getServerSpecs());
  sessionService.setToolsAwareness(() => awarenessNote(toolStatuses({ base: toolsBase })));
  if (options.structuredCommand) sessionService.setStructuredCommandOverride(options.structuredCommand);
  // Wakes watchers on peer status edges (see sessions/watch-dispatcher.ts) — wired as an
  // optional StatusService dependency, same shape as onActivity below.
  const watchDispatcher = new WatchDispatcher(db, buildWatchDeliver(sessionService));
  const statusService = new StatusService(db, broadcaster, undefined, (terminalId, status) => watchDispatcher.onStatus(terminalId, status));
  const harnessManagers = wireHarnesses(sessionService, statusService, db, broadcaster);
  const structuredManager = harnessManagers.get('claude-code')!;
  agentService.setLifecycleService(statusService);
  statusService.onHarnessCommitted(event => { if (event.type === 'process.exited') rolesService.handleTerminalExit(event.terminalId); });
  sessionService.setTerminalStatusWriter((id, status) => statusService.setTerminalState(id, status));

  wireThreadSettledPush(db, statusService, pushService);
  wirePtyUsageCapture(db, statusService, sessionService, broadcaster);
  rolesService.wireSettled(statusService);

  bootAnalytics(db);

  // Mount routes
  app.use('/api/sessions', createSessionsRouter(sessionService, broadcaster, db));
  app.use('/api', createTerminalsRouter(sessionService, undefined, statusService));
  app.use('/api/events', createEventsRouter(statusService));
  app.use('/api/agents', createAgentsRouter(agentService));
  app.use('/api/roles', createRolesRouter(rolesService));
  app.use('/api/providers', createProvidersRouter());
  app.use('/api/servers', createServersRouter(db));
  app.use('/api/secrets', createSecretsRouter(secretsService));
  app.use('/api/settings/harnesses', createHarnessSettingsRouter(db, secretsService));
  app.use('/api/transcribe', createTranscribeRouter(new TranscriptionService(secretsService)));
  app.use('/api/setup', createSetupRouter(db, secretsService));
  app.use('/api/sessions/:id/files', createFilesRouter(db));
  app.use('/api/sessions/:id/git', createGitRouter(db));
  app.use('/api/auth-requests', createAuthRouter(authRequestService));
  app.use('/api/claude-auth', createClaudeAuthRouter(new ClaudeLoginService(dispatchDir)));
  app.use('/api/state', createStateRouter(db));
  app.use('/api/integrations', createIntegrationsRouter(integrationsService));
  app.use('/api/push', createPushRouter(pushService));
  app.use('/api/tools', createToolsRouter({ base: toolsBase }));
  app.use('/api/update', createUpdateRouter(broadcaster, resolveRepoRoot(), db));
  app.use('/api/appearance', createAppearanceRouter(dispatchDir));
  app.use('/api/watches', createWatchesRouter(db));
  app.use('/api/analytics', createAnalyticsRouter(db));

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
  // Strip the mount prefix ONCE, before anything routes. Everything downstream —
  // all 18 route mounts, the static handler, the SPA fallback — keeps its existing
  // root-relative paths and is unaware the app is served under a prefix.
  if (BASE_PATH) app.use(stripBasePath(BASE_PATH));
  const boxGate = requireBoxToken(BOX_TOKEN);
  if (boxGate) app.use(boxGate);
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

  // Name once from the first submitted user prompt; transcript activity is a legacy
  // fallback. The shared broadcaster publishes the same tab refresh as manual rename.
  let resolveOpenRouterKey: (() => Promise<string | null>) | null = null;
  const threadAutoNamer = new ThreadAutoNamer(db, broadcaster, {
    getApiKey: () => resolveOpenRouterKey?.() ?? Promise.resolve(null),
  });

  // Determine actual server URL after port is known
  const sessionService = new SessionService(db, ptyManager, path.join(dataDir, 'mcp.json'));
  sessionService.setUserPromptListener((id, text) => threadAutoNamer.notifyPrompt(id, text));
  const agentService = new AgentService(db, sessionService, broadcaster, path.join(dataDir, 'runs'));
  // Built ahead of rolesService (moved up from its former spot below, alongside the other
  // *Pretty wiring) so it can be handed in as RolesService's optional push dep — backs the
  // 2-consecutive-failed-nights auto-disable Needs-you (Task 7).
  const pushService = new PushService(db, { vapidDir: dataDir });
  const rolesService = new RolesService({ db, agentService, sessionService, pushService });
  agentService.setRoleRunner(rolesService);
  // Wakes watchers on peer status edges (see sessions/watch-dispatcher.ts) — wired as an
  // optional StatusService dependency, same shape as the threadAutoNamer activity callback.
  const watchDispatcher = new WatchDispatcher(db, buildWatchDeliver(sessionService));
  const statusService = new StatusService(
    db, broadcaster,
    (id) => threadAutoNamer.notifyActivity(id),
    (terminalId, status) => watchDispatcher.onStatus(terminalId, status),
    (id, prompt) => threadAutoNamer.notifyPrompt(id, prompt),
  );
  const harnessManagers = wireHarnesses(sessionService, statusService, db, broadcaster);
  const structuredManager = harnessManagers.get('claude-code')!;
  const extraManagers = new Map([...harnessManagers].filter(([name]) => name !== 'claude-code'));
  agentService.setLifecycleService(statusService);
  statusService.onHarnessCommitted(event => { if (event.type === 'process.exited') rolesService.handleTerminalExit(event.terminalId); });
  sessionService.setTerminalStatusWriter((id, status) => statusService.setTerminalState(id, status));
  const opencodeStructured = extraManagers.get('opencode');

  // Fleet totals are a read-only projection of the canonical analytics ledger.
  const usage = new UsageRecorder(db);

  wireThreadSettledPush(db, statusService, pushService);
  wirePtyUsageCapture(db, statusService, sessionService, broadcaster);
  rolesService.wireSettled(statusService);

  // Doppler secrets: token-backed connection + per-spawn injection (DOPPLER_* env +
  // an MCP server) so Claude Code / Codex agents can add & retrieve secrets.
  const secretsService = new SecretsService(dataDir);
  const integrationsService = new IntegrationsService(db);
  // Terminal-free Claude login (design doc §11.2). Its token is injected below in
  // refreshPtyEnv, so a box authenticated mid-session takes effect on the next spawn
  // without a daemon restart.
  const claudeLogin = new ClaudeLoginService(dataDir);
  // Tools brokered by OS, resolved per spawn (design §4.2.1).
  const osConnections = new OsConnectionsProvider();
  const toolsBase = path.join(dataDir, 'tools');
  // Install the auto-namer's key resolver (declared above, next to the namer):
  // the OpenCode/OpenRouter key by its CONFIGURED Doppler name, resolved fresh
  // per naming attempt so key changes apply without a restart. null (not throw)
  // when Doppler isn't connected — the namer then keeps prefix-derived names.
  resolveOpenRouterKey = async () => {
    try { return (await secretsService.getSecret(opencodeKeySecretName(db))) ?? null; }
    catch { return null; }
  };
  sessionService.setSecretsServerSpec(() => ({ spec: secretsService.getServerSpec(), prompt: secretsService.getSystemPrompt() }));
  sessionService.setIntegrationsSpecs(() => [...integrationsService.getServerSpecs(), ...osConnections.getServerSpecs()]);
  sessionService.setToolsAwareness(() => awarenessNote(toolStatuses({ base: toolsBase })));
  let effectiveShimEnv = browserShimEnv;
  // Resolve the OpenCode/OpenRouter key from Doppler BY CONFIGURED NAME (settings/harness-
  // settings.ts) and layer it onto the opencode children's env as OPENROUTER_API_KEY.
  // Async on purpose (Doppler round-trip) atop the sync env refresh; re-fired on boot,
  // secrets connection changes, any secret write, and harness-settings PUTs — so saving or
  // renaming the key takes effect on the next spawn without a restart. Resolution failure
  // is fine: opencode falls back to its own auth store.
  const refreshOpencodeKeyEnv = (baseEnv: Record<string, string>) => {
    if (!opencodeStructured) return;
    void (async () => {
      try {
        const value = await secretsService.getSecret(opencodeKeySecretName(db));
        if (value) opencodeStructured.setDefaultEnv({ ...baseEnv, OPENROUTER_API_KEY: value });
      } catch { /* Doppler not connected — auth store fallback */ }
    })();
  };
  const refreshPtyEnv = () => {
    // claudeLogin and osConnections are the hosted box's two spawn-env providers:
    // the user's own Claude credential, and the MCP tools OS brokers per spawn. Both
    // are no-ops on a local daemon (no OS_BASE_URL, no login session), so one
    // composition serves both deployments rather than forking the spawn path.
    const spawnEnv = {
      ...effectiveShimEnv,
      ...claudeLogin.getSpawnEnv(),
      ...osConnections.getSpawnEnv(),
      ...secretsService.getSpawnEnv(),
      ...getToolsSpawnEnv({ base: toolsBase }),
    };
    // Each of those builds its own PATH off process.env.PATH, so the last spread wins
    // and the earlier prefixes are lost. Re-assert the shim's bin dir explicitly — without
    // it $BROWSER points at a `dispatch-open` that is not on PATH, and the whole
    // browser-auth relay silently does nothing. On a hosted box that relay is the ONLY
    // route an OAuth URL has to the person signing in: there is no local browser.
    spawnEnv.PATH = withShimPath(dataDir, spawnEnv.PATH);
    ptyManager.setDefaultEnv(spawnEnv);
    structuredManager.setDefaultEnv(spawnEnv);
    // The ACP children (Grok, OpenCode) run real tools directly (no app-server
    // indirection), so they need the same spawn env a PTY thread gets — secrets, bundled
    // tools, the browser shim.
    for (const manager of extraManagers.values()) manager.setDefaultEnv(spawnEnv);
    refreshOpencodeKeyEnv(spawnEnv);
  };
  secretsService.onChange(refreshPtyEnv);
  claudeLogin.onChange(refreshPtyEnv);
  refreshPtyEnv();

  // Terminal activity monitor — parses status bar, detects busy/idle
  const terminalMonitor = new TerminalMonitor(broadcaster, db, (terminalId, activity) => {
    agentService.updateRunFromTerminalActivity(terminalId, activity);
  }, (id) => threadAutoNamer.notifyActivity(id), (terminalId, url) => {
    // A CLI printed a sign-in URL instead of opening one — raise the same auth request the
    // $BROWSER shim raises, so it reaches the operator's banner (and their phone).
    //
    // ONLY for a thread Dispatch itself started to sign in (config.signIn). Scanning every
    // thread's output was far too loose: an agent that merely PRINTS an auth-shaped URL —
    // including one writing about OAuth, or a coding agent quoting a login link — raised a
    // banner. In practice the agent's own prose triggered a stream of them. A URL in a
    // sign-in thread is unambiguous; a URL anywhere else is just text. Every other thread
    // still relies on the shim, where an actual exec proves intent.
    try {
      const t = terminalsDb.getById(db, terminalId);
      const cfg = t ? (JSON.parse(t.config || '{}') as { signIn?: unknown }) : {};
      if (typeof cfg.signIn !== 'string') return;
      authRequestService.create({ url, source: 'terminal-output', terminalId });
    } catch { /* a malformed URL or config is not worth failing the output path over */ }
  });

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
    broadcaster.broadcast({ type: 'session:status', sessionId, status, lastActivityAt: sessionsDb.getLastActivity(db, sessionId) });
  }

  // When a PTY exits, clean up monitor and update status
  ptyManager.on('exit', (id: string, exitCode: number) => {
    terminalMonitor.remove(id);
    // During shutdown the DB is closed before node-pty's async exit events fire;
    // skip the DB work to avoid "database connection is not open" crashes.
    if (!db.open) return;
    // Flush a headless runner's final frames before publishing any settled state.
    let runnerOwned = agentService.ownsTerminalStream(id);
    try { agentService.handleTerminalExit(id, exitCode); }
    catch (error) { runnerOwned = false; console.error('agent run exit handler failed', error); }
    const terminal = terminalsDb.getById(db, id);
    if (terminal) {
      terminalsDb.updatePid(db, id, null);
      if (!runnerOwned) statusService.markExited(id, exitCode);
      sessionsDb.updatePid(db, terminal.session_id, null);
      rollupSession(terminal.session_id);
    } else {
      // Legacy: id is a session ID
      sessionsDb.updateStatus(db, id, 'waiting');
      sessionsDb.updatePid(db, id, null);
      broadcaster.broadcast({ type: 'session:status', sessionId: id, status: 'waiting', lastActivityAt: sessionsDb.getLastActivity(db, id) });
    }
  });

  bootAnalytics(db);

  // Mount routes
  app.use('/api/sessions', createSessionsRouter(sessionService, broadcaster, db));
  app.use('/api', createTerminalsRouter(sessionService, broadcaster, statusService));
  app.use('/api/events', createEventsRouter(statusService));
  app.use('/api/agents', createAgentsRouter(agentService));
  app.use('/api/roles', createRolesRouter(rolesService));
  app.use('/api/providers', createProvidersRouter());
  app.use('/api/servers', createServersRouter(db));
  app.use('/api/secrets', createSecretsRouter(secretsService, refreshPtyEnv));
  app.use('/api/settings/harnesses', createHarnessSettingsRouter(db, secretsService, refreshPtyEnv));
  app.use('/api/transcribe', createTranscribeRouter(new TranscriptionService(secretsService)));
  app.use('/api/setup', createSetupRouter(db, secretsService));
  app.use('/api/sessions/:id/files', createFilesRouter(db));
  app.use('/api/sessions/:id/git', createGitRouter(db));
  app.use('/api/auth-requests', createAuthRouter(authRequestService));
  app.use('/api/claude-auth', createClaudeAuthRouter(claudeLogin));

  app.use('/api/state', createStateRouter(db));
  app.use('/api/integrations', createIntegrationsRouter(integrationsService));
  app.use('/api/push', createPushRouter(pushService));
  app.use('/api/tools', createToolsRouter({ base: toolsBase }));
  const repoRoot = resolveRepoRoot();
  app.use('/api/update', createUpdateRouter(broadcaster, repoRoot, db));
  app.use('/api/appearance', createAppearanceRouter(dataDir));
  app.use('/api/watches', createWatchesRouter(db));
  app.use('/api/analytics', createAnalyticsRouter(db));

  // Serve the built web client (single-origin) when a build is present.
  // SPA fallback returns index.html for any non-/api, non-WS GET.
  const webDist = process.env.DISPATCH_WEB_DIST
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    // index.html is transformed (not sent as a file) so <base href> matches the mount
    // prefix. Read once at boot: the bundle is immutable for the life of the process.
    const indexHtml = indexHtmlWithBase(
      fs.readFileSync(path.join(webDist, 'index.html'), 'utf8'),
      BASE_PATH,
    );
    const sendIndex = (_req: express.Request, res: express.Response) => {
      res.type('html').send(indexHtml);
    };
    app.get('/icons/:name', customIconHandler(dataDir));
    app.use(express.static(webDist, { index: false }));
    app.get(/^\/(?!api\/).*/, sendIndex);
    console.log(`Serving web client from ${webDist}${BASE_PATH ? ` under ${BASE_PATH}` : ''}`);
  }

  // Handle HTTP upgrade for WebSocket connections
  server.on('upgrade', (request, socket, head) => {
    // The WS handler needs the same prefix strip as the HTTP side. Easy to overlook:
    // the two terminal regexes are unanchored so they'd still match a prefixed URL,
    // but the `url === '/api/events'` equality below would silently stop matching and
    // the events socket would just never connect.
    const stripped = stripPrefix(request.url || '', BASE_PATH);
    if (stripped === null) {
      socket.destroy();
      return;
    }
    // Express middleware never runs for an upgrade, so the box-token check has to be
    // repeated here. Protecting only the HTTP routes would leave every terminal and
    // structured socket — full interactive access to the box — wide open.
    if (!upgradeAllowed(BOX_TOKEN, request)) {
      socket.destroy();
      return;
    }
    const url = stripped;

    if (url.match(/\/api\/terminals\/[^/]+\/structured-ws/)) {
      structuredWss.handleUpgrade(request, socket, head, (ws) => {
        // Pick the RIGHT manager for this terminal's harness (claude stream-json vs codex
        // app-server) — both satisfy IStructuredManager, so the ws handler is transport-agnostic.
        // Falls back to the Claude manager when the terminal/type can't be resolved yet.
        const id = url.match(/\/api\/terminals\/([^/]+)\/structured-ws/)?.[1];
        const manager = (id && sessionService.structuredManagerForTerminal(id)) || structuredManager;
        handleStructuredConnection(
          ws, request, manager,
          (tid) => sessionService.ensureStructuredAlive(tid),
          (tid) => sessionService.historyOwnedByRest(tid),
          (tid) => sessionService.historyRestPageable(tid),
          // Settled = the daemon's own status row says the thread is not mid-turn. Drives
          // the phantom-"Working…" settle for replays that end mid-turn (see ws/structured.ts).
          (tid) => sessionService.getTerminal(tid)?.status !== 'working',
        );
      });
    } else if (url.match(/\/api\/terminals\/[^/]+\/ws/) || url.match(/\/api\/sessions\/[^/]+\/terminal/)) {
      terminalWss.handleUpgrade(request, socket, head, (ws) => {
        handleTerminalConnection(ws, request, ptyManager, sessionService, terminalMonitor, statusService);
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
    grokHelperPath: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/grok-hook.mjs'),
  });

  console.log(`Dispatch server listening on port ${port}`);

  // Prime the brokered-tool cache so the FIRST spawn after boot already has tools
  // (getServerSpecs is sync, so it can only ever serve a cached answer).
  void osConnections.refresh().then((s) => {
    if (osConnections.enabled) {
      console.log(`OS tools: ${s.servers.length} server(s), reachable=${s.reachable}`);
    }
  });

  // Per-box state projection for the OS control plane (design §4.4.5). Deliberately
  // not load-bearing for lifecycle — boxes are always-on, so a bad reading here
  // cannot stop a box mid-run.
  const boxHeartbeat = new HeartbeatService(db, () => ({
    authenticated: claudeLogin.isAuthenticated(),
    toolsReachable: osConnections.snapshot().reachable,
    usage7d: usage.total(7),
    usageByModel7d: usage.byModel(7),
  }));
  boxHeartbeat.start();

  // Boot recovery: auto-resume overseer threads (coordinator + typed agents) that
  // the previous shutdown interrupted mid-turn. Fire-and-forget — it waits a short
  // settle delay before reading status, so it must not block startup.
  void sessionService.kickstartInterruptedAgents()
    .then(({ kicked, skipped }) => {
      if (kicked.length) console.log(`Kickstart: resumed ${kicked.length} interrupted thread(s); skipped ${skipped.length}`);
    })
    .catch((err) => console.error('kickstart failed', err))
    .finally(() => statusService.reconcileProcesses((id) => ptyManager.isAlive(id) || !!sessionService.structuredManagerForTerminal(id)?.isAlive(id)));

  threadAutoNamer.resumePending();

  // Start PTY timing loop for Codex-style providers
  const ptyTimingInterval = startPtyTimingLoop(db, ptyManager, broadcaster, undefined, statusService);
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
    boxHeartbeat.stop();
    threadAutoNamer.dispose();
    ptyManager.killAll();
    structuredManager.killAll();
    for (const manager of extraManagers.values()) manager.killAll();
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
