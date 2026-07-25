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
import { createWatchesRouter } from './routes/watches.js';
import { WatchDispatcher } from './sessions/watch-dispatcher.js';

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
  structuredManager.on('idle', (terminalId: string, detail?: { declared: boolean; state?: 'done' | 'blocked'; blocker?: string; summary?: string }) => {
    statusService.markIdle(terminalId);
    // `declared` distinguishes an explicit report_status outcome from the undeclared
    // fallback (nothing declared, heuristic said "not a question") — the latter is a GUESS,
    // not a fact, so it's persisted as `inferred: true`. This is what keeps the
    // declared-vs-inferred split (GET /api/state/status-quality) honest instead of ~100%
    // by construction (see the review finding this fixes).
    //
    // `detail.state`/`detail.blocker`, when present, carry WHICH outcome the agent declared
    // (see the IStructuredManager doc comment in structured/manager.ts) — passed straight
    // through to noteTurnOutcome so `config.lastOutcome` can tell a `blocked` thread (still
    // proceeds without the human, queued behind something) apart from a genuinely finished
    // one, instead of both collapsing into the same "idle, not inferred" fact.
    //
    // `detail.summary`, when PRESENT, is the emitting manager's OWN text for this turn (the
    // Codex manager supplies it from the agentMessage it just stashed — see codex-manager.ts's
    // settleTurn), and its presence — not its truthiness — is the authority signal: a Codex
    // turn with no completed agentMessage (failed turn, interrupt before any prose, tool-only
    // turn) still sets `summary: ''`, and '' must be persisted as-is, NOT papered over by the
    // ring walk below (a truthiness check would fall through here and risk exactly the stale
    // text this fix exists to avoid). Only a GENUINELY absent field — the Claude manager never
    // sets `summary` at all — falls back to lastAssistantTextPublic: it scans for a WHOLE
    // `{type:'assistant', message.content:[{type:'text'}]}` event, which a live Codex turn never
    // produces (prose arrives as streaming deltas) — so on Codex that walk returns either '' or
    // STALE text backfilled from a previously resumed session, and used to get persisted into
    // config.lastOutcome on every single Codex turn (the Task 5 review finding this fixes). The
    // Claude path is unchanged: the ring walk IS reliable there (real whole-text `assistant`
    // events land in its ring).
    const summary = detail && 'summary' in detail ? (detail.summary ?? '') : sessionService.lastAssistantTextPublic(terminalId);
    sessionService.noteTurnOutcome(terminalId, { summary, needsHelp: false, inferred: !detail?.declared, state: detail?.state, blocker: detail?.blocker });
    sessionService.noteAgentCompletion(terminalId);
  });
  // A turn that ended needing the human. Deliberately NOT routed through 'idle':
  // markIdle settles the thread to `waiting` and noteAgentCompletion tells the
  // coordinator the agent "✅ just finished" — both wrong for a thread that stopped
  // to ask a question. It still needs its OWN escalation though — an agent's question
  // must reach its coordinator (same principle as the `permission` listener above),
  // just with correct "blocked, waiting" framing instead of a false completion note.
  structuredManager.on('needs-help', (terminalId: string, detail: { ask: string; summary: string; inferred: boolean }) => {
    statusService.markNeedsInput(terminalId, detail.inferred ? 'Asked a question' : detail.ask.slice(0, 120));
    sessionService.noteTurnOutcome(terminalId, { summary: detail.summary, needsHelp: true, inferred: detail.inferred });
    sessionService.noteAgentNeedsHelp(terminalId, detail.ask);
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
  const secretsService = options.secretsService ?? new SecretsService(dispatchDir);
  const integrationsService = new IntegrationsService(db);
  sessionService.setSecretsServerSpec(() => ({ spec: secretsService.getServerSpec(), prompt: secretsService.getSystemPrompt() }));
  sessionService.setIntegrationsSpecs(() => integrationsService.getServerSpecs());
  sessionService.setToolsAwareness(() => awarenessNote(toolStatuses({ base: toolsBase })));
  const structuredManager = new ClaudeStructuredSessionManager();
  sessionService.setStructuredManager(structuredManager);
  if (options.structuredCommand) sessionService.setStructuredCommandOverride(options.structuredCommand);
  // Wakes watchers on peer status edges (see sessions/watch-dispatcher.ts) — wired as an
  // optional StatusService dependency, same shape as onActivity below.
  const watchDispatcher = new WatchDispatcher(db, buildWatchDeliver(sessionService));
  const statusService = new StatusService(db, broadcaster, undefined, (terminalId, status) => watchDispatcher.onStatus(terminalId, status));
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
  app.use('/api/claude-auth', createClaudeAuthRouter(new ClaudeLoginService(dispatchDir)));
  app.use('/api/state', createStateRouter(db));
  app.use('/api/integrations', createIntegrationsRouter(integrationsService));
  app.use('/api/push', createPushRouter(pushService));
  app.use('/api/tools', createToolsRouter({ base: toolsBase }));
  app.use('/api/update', createUpdateRouter(broadcaster, resolveRepoRoot(), db));
  app.use('/api/appearance', createAppearanceRouter(dispatchDir));
  app.use('/api/watches', createWatchesRouter(db));

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

  // Debounced, best-effort thread auto-namer — fed by real-activity signals from
  // StatusService (hook events) and TerminalMonitor (PTY busy/idle), below. Uses the
  // real (websocket-wired) broadcaster so a successful rename's `session:tabs-changed`
  // reaches connected clients the same way a user rename does today.
  const threadAutoNamer = new ThreadAutoNamer(db, broadcaster);

  // Determine actual server URL after port is known
  const sessionService = new SessionService(db, ptyManager, path.join(dataDir, 'mcp.json'));
  const agentService = new AgentService(db, sessionService, broadcaster, path.join(dataDir, 'runs'));
  // Wakes watchers on peer status edges (see sessions/watch-dispatcher.ts) — wired as an
  // optional StatusService dependency, same shape as the threadAutoNamer activity callback.
  const watchDispatcher = new WatchDispatcher(db, buildWatchDeliver(sessionService));
  const statusService = new StatusService(
    db, broadcaster,
    (id) => threadAutoNamer.notifyActivity(id),
    (terminalId, status) => watchDispatcher.onStatus(terminalId, status),
  );
  const structuredManager = new ClaudeStructuredSessionManager();
  sessionService.setStructuredManager(structuredManager);
  wirePermissionMembrane(structuredManager, statusService, sessionService);
  const codexManager = wireCodexPretty(sessionService, statusService);
  const pushService = new PushService(db, { vapidDir: dataDir });

  // Token usage for INTERACTIVE threads. Scheduled runs already record theirs on
  // agent_runs; interactive threads discarded it, which left no way to answer the
  // question a hosted fleet needs: who is close to their weekly rate limit.
  const usage = new UsageRecorder(db);
  structuredManager.on('event', (_id: string, event: unknown) => usage.observe(event));
  codexManager?.on('event', (_id: string, event: unknown) => usage.observe(event));

  wireThreadSettledPush(db, statusService, pushService);

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
  sessionService.setSecretsServerSpec(() => ({ spec: secretsService.getServerSpec(), prompt: secretsService.getSystemPrompt() }));
  sessionService.setIntegrationsSpecs(() => [...integrationsService.getServerSpecs(), ...osConnections.getServerSpecs()]);
  sessionService.setToolsAwareness(() => awarenessNote(toolStatuses({ base: toolsBase })));
  let effectiveShimEnv = browserShimEnv;
  const refreshPtyEnv = () => {
    // getToolsSpawnEnv prepends the bundled-tools bin to a BASE PATH. That base must be
    // the shim env's PATH (which itself prepends ~/.dispatch/bin), not process.env.PATH —
    // otherwise this spread, being last, silently drops the browser shim from PATH and
    // BROWSER=dispatch-open resolves to nothing. Locally that's invisible (macOS Claude
    // Code opens the browser itself and the loopback callback still lands), but on a
    // headless/remote box the shim is the ONLY way an OAuth URL reaches the operator.
    const toolsEnv = getToolsSpawnEnv({ base: toolsBase, env: { ...process.env, ...effectiveShimEnv } });
    const spawnEnv = { ...effectiveShimEnv, ...claudeLogin.getSpawnEnv(), ...osConnections.getSpawnEnv(), ...secretsService.getSpawnEnv(), ...toolsEnv };
    ptyManager.setDefaultEnv(spawnEnv);
    structuredManager.setDefaultEnv(spawnEnv);
  };
  secretsService.onChange(refreshPtyEnv);
  claudeLogin.onChange(refreshPtyEnv);
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
  app.use('/api/claude-auth', createClaudeAuthRouter(claudeLogin));

  app.use('/api/state', createStateRouter(db));
  app.use('/api/integrations', createIntegrationsRouter(integrationsService));
  app.use('/api/push', createPushRouter(pushService));
  app.use('/api/tools', createToolsRouter({ base: toolsBase }));
  const repoRoot = resolveRepoRoot();
  app.use('/api/update', createUpdateRouter(broadcaster, repoRoot, db));
  app.use('/api/appearance', createAppearanceRouter(dataDir));
  app.use('/api/watches', createWatchesRouter(db));

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
    boxHeartbeat.stop();
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
