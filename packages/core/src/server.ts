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
import { ptyMessagePayload } from './sessions/pty-message.js';
import { PTYManager } from './pty/manager.js';
import { AgentService } from './agents/service.js';
import { createDaemonStallWatchdog } from './runtime/stall-watchdog.js';
import { RolesService } from './roles/service.js';
import { aggregateSessionStatus } from './status/aggregate.js';
import { AuthRequestService } from './auth/service.js';
import { ClaudeLoginService } from './auth/claude-login.js';
import { createBoxGate, upgradeAllowed } from './auth/box-token.js';
import { createAccessGate } from './auth/access-gate.js';
import { createTokenSource } from './auth/access-token.js';
import { KeyRegistry } from './auth/principals.js';
import { createKeyScope } from './auth/key-scope.js';
import {
  createLoginKeyCheck, createPrincipalMiddleware, refuseKeyUpgrade,
} from './auth/request-principal.js';
import { createNoCredentialStats } from './auth/no-credential-stats.js';
import { publicRoute, looksLikeBrowser } from './auth/route-policy.js';
import { createPairCodes } from './auth/pair-code.js';
import { createDeviceStore } from './auth/devices.js';
import { reachableAddresses } from './auth/reachable-addresses.js';
import { mountApiRoutes } from './server-routes.js';
import { jsonErrorHandler } from './http/error-handler.js';
import { createJsonBody } from './http/json-body.js';
import { createClientWss } from './ws/client-wss.js';
import { wsMaxPayload, wsTerminalMaxPayload } from './caps.js';
import type { ApiRouteDeps } from './server-routes.js';
import { createAccessConfig } from './auth/known-hosts.js';
import { createTailscaleAccess } from './auth/tailscale-access.js';
import { securityHeaders } from './auth/security-headers.js';
import { compressedAssets, createIndexProvider, IMMUTABLE } from './web-assets.js';
import { jsonCompression } from './http/compress.js';
import { lockDownDataDir } from './auth/private-dir.js';
import { OsConnectionsProvider } from './integrations/os-provider.js';
import { HeartbeatService } from './platform/heartbeat.js';
import { writeOwnPid, removeOwnPid } from './platform/pid-file.js';
import { UsageRecorder } from './usage/recorder.js';
import { closeInterruptedTurns } from './analytics/recorder.js';
import { attachPtyCapture } from './analytics/pty-capture.js';
import * as usageDb from './db/usage.js';
import { startTelemetryLoop } from './telemetry/sender.js';
import { opencodeKeySecretName, skipClaudeAgentSummaries } from './settings/harness-settings.js';
import { warmModelCapabilities } from './settings/model-capabilities.js';
import { warmClaudeVersion, prunePromptFiles, setClaudeProbeEnv } from './providers/claude-prompt-file.js';
import { setProviderProbeEnv } from './setup/detect.js';
import { withShimPath } from './auth/shim.js';
import { installAgentSummaryHook, withAgentSummaryPreload } from './providers/claude-agent-summary.js';
import { getToolsSpawnEnv, toolStatuses, awarenessNote } from './tools/status.js';
import { ToolAuthProber } from './tools/auth-probe.js';
import { SecretsService } from './secrets/service.js';
import { sweepThreadMcpConfigs, sweepThreadKeyFiles } from './sessions/mcp-config-sweep.js';
import { IntegrationsService, type IntegrationLauncher } from './integrations/service.js';
import { PushService } from './push/service.js';
import { installProcessGuards } from './runtime/process-guards.js';
import { wireThreadSettledPush } from './push/notify.js';
import { StatusService } from './status/service.js';
import { createEventsBroadcaster, answerEventsPing, createNoopBroadcaster } from './ws/events.js';
import type { EventBroadcaster } from './ws/events.js';
import { handleTerminalConnection } from './ws/terminal.js';
import { handleStructuredConnection } from './ws/structured.js';
import { ClaudeStructuredSessionManager, type IStructuredManager } from './structured/manager.js';
import { CodexStructuredSessionManager } from './structured/codex-manager.js';
import { GrokStructuredSessionManager } from './structured/grok-manager.js';
import { startPtyTimingLoop } from './sessions/status.js';
import { startAutoArchiveLoop } from './sessions/auto-archive.js';
import { startInterimRecapLoop } from './sessions/interim-recap.js';
import { UsageLimitService, CHAT_ID, isChatTurnId } from './limits/service.js';
import { PtyLimitWatcher } from './limits/pty-watch.js';
import { LimitSnapshots, parseClaudeRateLimit } from './limits/snapshot.js';
import { accountIdFor, tokenAccountId, codexAccountId, codexLoginChangedAt } from './limits/account.js';

/** A thread's own account id from its config JSON, or null when it names none. */
function threadAccountId(config: string | null | undefined): string | null {
  try { const c = JSON.parse(config || '{}'); return typeof c?.accountId === 'string' && c.accountId ? c.accountId : null; } catch { return null; }
}
import { createUsageLimitsRouter } from './routes/usage-limits.js';
import { UsageGauge } from './limits/gauge.js';
import { createCodexRefresh } from './limits/codex-refresh.js';
import { createCodexPoll } from './limits/codex-poll.js';
import { createClaudeProbe } from './limits/claude-probe.js';
import { createClaudeUsageReader, readClaudeToken, fetchClaudeProfile } from './limits/claude-usage.js';
import { AccountsStore, adoptClaudeLoginToken, type AccountProvider } from './auth/accounts.js';
import { CodexLoginService } from './auth/codex-login.js';
import { TerminalMonitor } from './terminal-monitor.js';
import { ThreadAutoNamer } from './sessions/thread-auto-namer.js';
import { inheritedEnv } from './platform/inherited-env.js';
import { claudeTitleGenerator, codexTitleGenerator, firstTitle, usable } from './sessions/cli-namer.js';
import { pickHarness } from './plugins/assist-share.js';
import { platform } from './platform/index.js';
import { startUpdateCheckLoop } from './update/checker.js';
import { finishRestartedUpdate } from './update/progress.js';
import { guardLoopback } from './platform/loopback-guard.js';
import { listenOn, parseBindHost, writeListenInfo } from './platform/bind.js';
import type { AddressInfo } from 'node:net';
import { getRunningVersion } from './update/version.js';
import { PluginRegistry } from './plugins/registry.js';
import { migratePreviews } from './plugins/previews-migration.js';
import { ThreadEvents, isAutomatedThread } from './plugins/thread-events.js';
/** A terminal row's config (JSON text) names a thread a schedule or a role started. */
const automatedConfig = (config: string | null | undefined): boolean => { try { return isAutomatedThread(JSON.parse(config || '{}')); } catch { return false; } };
import { PluginHooks } from './plugins/hooks.js';
import { PluginWorkers } from './plugins/workers.js';
import { MarketplaceService } from './plugins/marketplaces.js';
import { PluginInstaller } from './plugins/installer.js';
import { SkillsService } from './plugins/skills.js';
import { createAssistRunner, commandAssistRunner, type AssistRunner, type AssistHarness } from './assist/run.js';
import * as pluginData from './db/plugin-data.js';
import { configurePluginFacts } from './auth/plugin-facts.js';
import { pluginAssetHandler } from './routes/plugins.js';
import { customIconHandler } from './routes/appearance.js';
import { LedgerService } from './overseer/ledger-service.js';
import { WatchDispatcher } from './sessions/watch-dispatcher.js';
import type { DeliverResult } from './delivery/outbox.js';
import { createDeliveryOutbox, subscribeDeliveryOutbox, flushOutboxAtBoot } from './delivery/wiring.js';
import { reconcileAtBoot, wireRestoredQuestions } from './sessions/boot-reconcile.js';
import { trackingStartedAt } from './routes/analytics.js';
import { EndlessService, limitsFromEnv, startEndless } from './endless/service.js';

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

/**
 * A pick the harness refused late and the daemon took back out of a thread's config: the web reloads the thread so the chip
 * shows what the thread runs. createApp and startServer both call it.
 */
export function wireTerminalChanged(sessionService: SessionService, broadcaster: EventBroadcaster): void {
  sessionService.setTerminalChangedListener((sessionId) => broadcaster.broadcast({ type: 'session:tabs-changed', sessionId }));
}

/**
 * The decision ledger's live wiring (pinned card spec 2026-10-08, Unit 3): every write of either
 * LedgerService — the router's, returned here, and the one inside SessionService (the agent
 * owner-decisions capture) — broadcasts `ledger:changed` on the events socket, so the web app's
 * pinned card loads again. A failed broadcast never fails the write (LedgerService catches it).
 *
 * createApp and startServer both call this, so the two app builders cannot drift.
 */
export function wireLedger(db: Database.Database, sessionService: SessionService, broadcaster: EventBroadcaster): LedgerService {
  const onChange = (sessionId: string) => broadcaster.broadcast({ type: 'ledger:changed', sessionId });
  sessionService.setLedgerChangeListener(onChange);
  return new LedgerService(db, { onChange });
}

/** Repo root, derived the same way as the webDist fallback below (works from both src/ in dev and dist/ once built, since both sit at the same depth under packages/core). */
function resolveRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
}

/**
 * The integration launcher (integrations/launcher.ts) for integrations with `${NAME}` refs,
 * reading the Doppler connection saved in `secretsDir` — the SecretsService's own dir. Null
 * when the compiled launcher.js isn't there (a tsx dev run), so those integrations keep
 * their plain spec rather than point a harness at a missing file.
 */
function integrationLauncher(secretsDir: string): IntegrationLauncher | null {
  const launcherPath = fileURLToPath(new URL('./integrations/launcher.js', import.meta.url));
  return fs.existsSync(launcherPath) ? { nodePath: process.execPath, launcherPath, secretsDir } : null;
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

// Lives in web-assets.ts with the index.html provider (W1-E); exported from here as before.
export { indexHtmlWithBase } from './web-assets.js';

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
  /** The plugins folder (defaults to <secretsDir>/plugins). */
  pluginsDir?: string;
  /** Model assist for plugins; tests inject a fake, and omit it for none. */
  assistRunner?: AssistRunner | null;
  /** The bundled plugins folder (defaults to <repo>/packages/plugins; tests pass a temp one or none). */
  bundledDir?: string | null;
  /** Inject a pre-built SecretsService (e.g. with a fake Doppler client) for tests. */
  secretsService?: SecretsService;
  /** Override the structured command (test seam: spawn fake-claude instead of real claude). */
  structuredCommand?: { command: string; args: string[] };
  /** Inject the key registry (tests mint keys through it). Exposed as `app.locals.keys`. */
  keys?: KeyRegistry;
  /** Chat service (a stub in tests). Without it `/api/endless` answers 503. */
  endless?: EndlessService;
  /** Test seam: mounts `/api/usage-limits` (the daemon always does). */
  usageLimits?: ApiRouteDeps['usageLimits'];
  /** Test seam: the accounts the plugin assist route knows (without it, only `cli`). */
  assistAccounts?: ApiRouteDeps['assistAccounts'];
  /**
   * Structured managers by provider name, in place of the real Claude, Codex, Grok and opencode
   * managers (test seam: no CLI runs). Must include `claude-code`.
   */
  managers?: Map<string, IStructuredManager>;
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
function wirePermissionMembrane(manager: IStructuredManager, status: StatusService, sessions: SessionService, db: Database.Database, _broadcaster: EventBroadcaster, threadEvents?: ThreadEvents): void {
  // Plugins observe every native frame (tool_use blocks) and every harness event (turns, usage).
  if (threadEvents) manager.on('event', (id: string, frame: unknown) => { try { threadEvents.onNativeFrame(id, frame); } catch { /* observers never block */ } });
  subscribeHarnessEvents(manager, id => db.open ? terminalsDb.getById(db, id)?.type : undefined, event => { try { threadEvents?.onHarnessEvent(event); } catch { /* observers never block */ } status.accept(event, committed => {
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
  }); });
}

/** Every additional harness receives identical registration, lifecycle and accounting wiring. */
function wireHarnesses(sessionService: SessionService, status: StatusService, db: Database.Database, broadcaster: EventBroadcaster, injected?: Map<string, IStructuredManager>, threadEvents?: ThreadEvents): Map<string, IStructuredManager> {
  const managers = new Map<string, IStructuredManager>();
  if (injected) {
    // Test seam: the caller's managers stand in for the real CLI managers, so no CLI runs.
    for (const [name, manager] of injected) {
      sessionService.registerStructuredManager(name, manager);
      wirePermissionMembrane(manager, status, sessionService, db, broadcaster, threadEvents);
      managers.set(name, manager);
    }
    return managers;
  }
  for (const provider of listProviders()) {
    if (provider.structured.disabledBy && process.env[provider.structured.disabledBy] === '0') continue;
    const manager = provider.structured.protocol === 'claude-json' ? new ClaudeStructuredSessionManager()
      : provider.structured.protocol === 'acp' ? new GrokStructuredSessionManager(provider.structured.dialect)
      : new CodexStructuredSessionManager();
    sessionService.registerStructuredManager(provider.name, manager);
    wirePermissionMembrane(manager, status, sessionService, db, broadcaster, threadEvents);
    managers.set(provider.name, manager);
  }
  return managers;
}

/**
 * Builds the deliver function for a watch wake (the delivery outbox calls it for a `watch` row):
 * picks transport per target the SAME way spawnTerminal/ensureStructuredAlive already do —
 * `config.transport === 'structured'` AND a structured manager exists for that harness.
 * Structured threads get `ensureStructuredAlive` (lazily resumes a dead one) +
 * `sendStructuredMessage`; everything else (PTY threads — claude-code/codex still on the CLI
 * transport) gets the wake typed in and submitted (`ptyMessagePayload`), exactly as
 * `sendThreadMessage` delivers a peer message to a CLI thread.
 *
 * The answer tells the outbox what to do with the row (W2-C). `gone`: the watcher vanished or is
 * a shell tab; the wake is dropped. `not-alive`: nothing can take the wake now (a CLI thread with
 * no process, a Pretty thread that could not be started); the wake waits and the watch stays
 * live. Before, that wake was typed into nothing and the watch was spent.
 */
export function buildWatchDeliver(sessionService: SessionService): (terminalId: string, text: string) => DeliverResult {
  return (terminalId: string, text: string) => {
    const terminal = sessionService.getTerminal(terminalId);
    if (!terminal) return 'gone'; // watcher vanished between lookup and delivery — nothing to do
    // A shell tab would run the wake text as a command (also covers a watch stored before the route refused it).
    if (terminal.type === 'shell') return 'gone';
    if (terminal.config?.transport === 'structured' && sessionService.structuredManagerFor(terminal.type)) {
      if (sessionService.ensureStructuredAlive(terminalId) === false) return 'not-alive';
      sessionService.sendStructuredMessage(terminalId, text);
    } else {
      if (!sessionService.isThreadProcessAlive(terminalId)) return 'not-alive';
      // Same bytes a peer message to a CLI thread uses: a bare "\n" only types a newline into the
      // input box, so the parent never woke. Bracketed paste, then one CR, submits it.
      sessionService.writeToTerminal(terminalId, ptyMessagePayload(text));
    }
    return 'delivered';
  };
}

export function createApp(options: CreateAppOptions): import('express').Express {
  const { db, skipPty = false } = options;

  const app = express();
  const keys = options.keys ?? new KeyRegistry();
  app.locals.keys = keys;
  const noCredentialStats = createNoCredentialStats({});
  app.use(createPrincipalMiddleware({ registry: keys, scope: createKeyScope(db), via: 'test' }));
  app.use(createJsonBody()); // 1 MiB; the few routes with big payloads get the large cap (http/json-body.ts)
  app.use(jsonCompression()); // API JSON over 1 KB goes out as br or gzip (http/compress.ts)

  const ptyManager = skipPty ? new NoopPTYManager() : new PTYManager();
  const serverUrl = 'http://localhost:3456'; // Updated at runtime in startServer

  // For testing, use a no-op broadcaster; in production, wired up in startServer
  const broadcaster: EventBroadcaster = createNoopBroadcaster();
  const authRequestService = new AuthRequestService(broadcaster);

  const dispatchDir = options.secretsDir ?? platform.dataDir();
  const toolsBase = options.toolsDir ?? path.join(dispatchDir, 'tools');
  // Plugins (docs/superpowers/specs/2026-11-07-plugins-design.md): no watcher here; startServer runs one.
  const plugins = new PluginRegistry(options.pluginsDir ?? path.join(dispatchDir, 'plugins'), broadcaster, getRunningVersion(), { keys, keyDir: path.join(dispatchDir, 'keys'), bundledDir: options.bundledDir === undefined ? undefined : options.bundledDir ?? undefined });
  configurePluginFacts((id) => plugins.facts(id));
  plugins.issueKeys();
  try { migratePreviews(db); } catch (e) { console.warn('[plugins] the previews migration failed; the daemon runs without it:', e instanceof Error ? e.message : e); }
  app.locals.plugins = plugins;
  // Marketplaces and installs (spec section 7): the router reads them from app.locals.
  const marketplaces = new MarketplaceService(path.join(dispatchDir, 'marketplaces'), path.join(dispatchDir, 'marketplaces.json'));
  app.locals.marketplaces = marketplaces;
  app.locals.installer = new PluginInstaller(plugins, marketplaces, options.pluginsDir ?? path.join(dispatchDir, 'plugins'), getRunningVersion(), path.join(dispatchDir, 'installer.json'));
  const skills = new SkillsService(path.join(dispatchDir, 'skills'), path.join(dispatchDir, 'skills.json'), marketplaces);
  app.locals.skills = skills;
  plugins.setAssistTotalsProvider((id) => pluginData.assistTotals(db, id));
  const threadEvents = new ThreadEvents(broadcaster, (id) => { const t = db.open ? terminalsDb.getById(db, id) : null; return t ? { sessionId: t.session_id, harness: t.type, automated: automatedConfig(t.config) } : null; });
  app.locals.threadEvents = threadEvents;
  const sessionService = new SessionService(db, ptyManager, path.join(dispatchDir, 'mcp.json'));
  sessionService.setKeyRegistry(keys, { keyDir: path.join(dispatchDir, 'keys') });
  const agentService = new AgentService(db, sessionService, broadcaster);
  // Built ahead of rolesService (moved up from below) so it can be handed in as
  // RolesService's optional push dep — backs the 2-consecutive-failed-nights
  // auto-disable Needs-you (Task 7).
  const pushService = new PushService(db, { vapidDir: dispatchDir });
  const rolesService = new RolesService({ db, agentService, sessionService, pushService });
  agentService.setRoleRunner(rolesService);
  const secretsService = options.secretsService ?? new SecretsService(dispatchDir);
  const integrationsService = new IntegrationsService(db, integrationLauncher(dispatchDir), () => { const st = secretsService.status(); return st.connected && st.enabled; });
  sessionService.setSecretsServerSpec(() => ({ spec: secretsService.getServerSpec(), prompt: secretsService.getSystemPrompt() }));
  sessionService.setIntegrationsSpecs(() => integrationsService.getServerSpecs());
  // Unlike startServer, no refresh at boot or behind a spawn: tests spawn sessions through this
  // app and toolsBase can be the real ~/.dispatch/tools. Checks run only from GET /api/tools.
  const toolsAuth = new ToolAuthProber({ base: toolsBase });
  sessionService.setToolsAwareness(() => awarenessNote(toolStatuses({ base: toolsBase, env: toolsAuth.threadEnv(), checks: toolsAuth.snapshot().results })));
  if (options.structuredCommand) sessionService.setStructuredCommandOverride(options.structuredCommand);
  // Wakes watchers on peer status edges (see sessions/watch-dispatcher.ts) — wired as an
  // optional StatusService dependency, same shape as onActivity below.
  // A wake and a worker's notice are written to the delivery outbox first, then delivered (W2-C).
  const outbox = createDeliveryOutbox(db, sessionService, buildWatchDeliver(sessionService));
  const watchDispatcher = new WatchDispatcher(db, outbox);
  const statusService = new StatusService(db, broadcaster, undefined, (terminalId, status) => watchDispatcher.onStatus(terminalId, status));
  subscribeDeliveryOutbox(outbox, statusService);
  // Plugins observe hook payloads, spawns, declarations and prompts (docs/superpowers/specs/2026-11-07-plugins-design.md, section 3.3).
  statusService.setHookListener((p, id, payload) => threadEvents.onHookPayload(p, id, payload));
  sessionService.setSpawnListener((id, tools) => threadEvents.onSpawned(id, tools));
  sessionService.setStatusDeclaredListener((id, decl) => threadEvents.onStatus(id, decl));
  sessionService.setPluginInjection((harness, sessionId) => { const inj = plugins.modelInjection(harness); return { ...inj, prompts: [...inj.prompts, ...skills.injection(sessionId, harness)] }; });
  sessionService.setUserPromptListener((id, text, source) => threadEvents.onPrompt(id, text, source));
  const harnessManagers = wireHarnesses(sessionService, statusService, db, broadcaster, options.managers, threadEvents);
  wireRestoredQuestions(db, sessionService, harnessManagers.values(), statusService); // a pending question survives a restart (W2-C)
  const structuredManager = harnessManagers.get('claude-code')!;
  agentService.setLifecycleService(statusService);
  statusService.onHarnessCommitted(event => { if (event.type === 'process.exited') rolesService.handleTerminalExit(event.terminalId); });
  sessionService.setTerminalStatusWriter((id, status) => statusService.setTerminalState(id, status));
  wireTerminalChanged(sessionService, broadcaster);

  wireThreadSettledPush(db, statusService, pushService);
  wirePtyUsageCapture(db, statusService, sessionService, broadcaster);
  rolesService.wireSettled(statusService);

  bootAnalytics(db);

  // Mount routes (the one list, shared with startServer)
  mountApiRoutes(app, {
    db, sessionService, statusService, agentService, rolesService, authRequestService,
    claudeLogin: new ClaudeLoginService(dispatchDir), secretsService, integrationsService, pushService,
    ledgerService: wireLedger(db, sessionService, broadcaster),
    toolsBase, toolsAuth, dataDir: dispatchDir, repoRoot: resolveRepoRoot(),
    broadcaster, plugins, assistRunner: options.assistRunner ?? null, noCredentialStats, endless: options.endless, usageLimits: options.usageLimits, assistAccounts: options.assistAccounts,
    watchCatchUp: (id) => watchDispatcher.catchUp(id), outbox,
  });

  // Attach internals for server wiring
  (app as any)._ptyManager = ptyManager;
  (app as any)._sessionService = sessionService;
  (app as any)._pushService = pushService;
  (app as any)._structuredManager = structuredManager;

  // Serve the built web client (single-origin) when a build is present.
  // SPA fallback returns index.html for any non-/api, non-WS GET.
  const webDist = process.env.DISPATCH_WEB_DIST
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  // Plugin files, with or without a web build (the dev server proxies /plugins here).
  app.get('/plugins/:id/*', ...pluginAssetHandler(plugins));
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.get('/icons/:name', publicRoute, customIconHandler(dispatchDir));
    app.use('/assets', compressedAssets(path.join(webDist, 'assets')));
    app.use(express.static(webDist, {
      setHeaders: (res, file) => { if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', IMMUTABLE); },
    }));
    app.get(/^\/(?!api\/).*/, publicRoute, (_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  app.use(jsonErrorHandler);
  return app;
}

export async function startServer(options?: { port?: number; allowRandomPortFallback?: boolean }): Promise<{ port: number; cleanup: () => void; keys: KeyRegistry }> {
  const preferredPort = options?.port ?? 3456;
  // DISPATCH_BIND: checked first, so an invalid value stops the start before anything is opened or spawned.
  const bindHost = parseBindHost(process.env.DISPATCH_BIND);

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
  // Private to the user before anything else is written (network exposure spec 7.14).
  lockDownDataDir(dataDir, [platform.logDir()]);

  // The daemon's own address for first-party callers (hooks, the shim, MCP helpers): loopback, the
  // bound port and the base path. It is also the only destination that a thread key may be sent to.
  let daemonApi = `http://127.0.0.1:${preferredPort}${BASE_PATH}`;
  const browserShimEnv = platform.installBrowserShim({
    dataDir,
    serverUrl: daemonApi,
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
  app.use(securityHeaders);
  if (BASE_PATH) app.use(stripBasePath(BASE_PATH));
  // The owner token file exists in both modes (a box admits the token as well as the box header).
  const getAccessToken = createTokenSource(dataDir);
  const keys = new KeyRegistry();
  const noCredentialStats = createNoCredentialStats({});
  if (BOX_TOKEN) app.use(createBoxGate({ boxToken: BOX_TOKEN, registry: keys, getToken: getAccessToken }));
  // The request gate (network exposure spec, section 7). On a hosted box the box token above is
  // the credential and the router is the only caller, so the gate stays out of the way there.
  // One-time sign-in codes (Settings → Devices & access) that stand in for the token on the login route.
  const pairCodes = createPairCodes();
  // Signed-in devices: one row per browser or phone that signed in. Not on a hosted box, where
  // the router holds the box token and there is no sign-in page.
  const devices = BOX_TOKEN ? undefined : createDeviceStore(db, { getToken: getAccessToken });
  const tailscaleAccess = createTailscaleAccess();
  const accessGate = BOX_TOKEN
    ? undefined
    : createAccessGate({
        getToken: getAccessToken,
        isGatewayPeer: (a) => platform.isHostGatewayPeer(a),
        config: createAccessConfig(dataDir),
        tailscale: tailscaleAccess,
        basePath: BASE_PATH,
        pairCodes,
        devices,
      });
  if (accessGate) {
    // Before the gate, which has no login exemption. A key never signs in (spec 6.4).
    app.post('/api/access/login', createLoginKeyCheck({ registry: keys }), ...accessGate.loginRoute);
    app.use(accessGate.middleware);
  }
  app.use(createPrincipalMiddleware({
    registry: keys, scope: createKeyScope(db), getToken: getAccessToken, boxToken: BOX_TOKEN, stats: noCredentialStats, devices,
  }));
  app.use(createJsonBody()); // 1 MiB; the few routes with big payloads get the large cap (http/json-body.ts)
  app.use(jsonCompression()); // API JSON over 1 KB goes out as br or gzip (http/compress.ts)
  // Create HTTP server
  const server = http.createServer(app);

  // Create WebSocket servers (noServer mode)
  // maxPayload: one client message over the cap closes that socket (the default of ws is 100 MiB).
  const eventsWss = createClientWss(wsMaxPayload(), { deflate: true }); // JSON text: permessage-deflate (ws/client-wss.ts)
  const terminalWss = createClientWss(wsTerminalMaxPayload()); // typed and pasted input comes through this one
  const structuredWss = createClientWss(wsMaxPayload(), { deflate: true });

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
  const plugins = new PluginRegistry(path.join(dataDir, 'plugins'), broadcaster, getRunningVersion(), { keys, keyDir: path.join(dataDir, 'keys'), bundledDir: path.join(resolveRepoRoot(), 'packages', 'plugins') });
  configurePluginFacts((id) => plugins.facts(id));
  plugins.issueKeys();
  try { migratePreviews(db); } catch (e) { console.warn('[plugins] the previews migration failed; the daemon runs without it:', e instanceof Error ? e.message : e); }
  plugins.start();
  const marketplaces = new MarketplaceService(path.join(dataDir, 'marketplaces'), path.join(dataDir, 'marketplaces.json'));
  const installer = new PluginInstaller(plugins, marketplaces, path.join(dataDir, 'plugins'), getRunningVersion(), path.join(dataDir, 'installer.json'));
  const skills = new SkillsService(path.join(dataDir, 'skills'), path.join(dataDir, 'skills.json'), marketplaces);
  // Pull every marketplace on the updater's schedule (and once soon after boot); auto-updates apply then.
  const marketplaceCheck = setInterval(() => { void installer.checkNow().catch(() => {}); }, 45 * 60 * 1000);
  marketplaceCheck.unref?.();
  const marketplaceFirstCheck = setTimeout(() => { void installer.checkNow().catch(() => {}); }, 20_000);
  marketplaceFirstCheck.unref?.();
  const threadEvents = new ThreadEvents(broadcaster, (id) => { const t = db.open ? terminalsDb.getById(db, id) : null; return t ? { sessionId: t.session_id, harness: t.type, automated: automatedConfig(t.config) } : null; });
  const authRequestService = new AuthRequestService(broadcaster);

  // Name once from the first submitted user prompt; transcript activity is a legacy
  // fallback. The shared broadcaster publishes the same tab refresh as manual rename.
  // Titles: Claude Haiku via `claude -p`, then Codex, on the user's own sign-ins, and only
  // then OpenRouter (cli-namer.ts). The CLIs run under the thread spawn env (set by
  // refreshPtyEnv below), so Dispatch's saved Claude token signs them in like a thread.
  let resolveOpenRouterKey: (() => Promise<string | null>) | null = null;
  let titleSpawnEnv: Record<string, string> = {};
  const titleCliDeps = { env: () => ({ ...inheritedEnv(), ...titleSpawnEnv }) };
  // Model assist for plugins (spec section 3.4): the same signed-in CLI the titles use, else the OpenRouter key.
  const assistRunner = process.env.DISPATCH_ASSIST_COMMAND
    ? commandAssistRunner(process.env.DISPATCH_ASSIST_COMMAND)
    : createAssistRunner({
      cli: titleCliDeps, getApiKey: () => resolveOpenRouterKey?.() ?? Promise.resolve(null),
      // The account a call signs in as (multi-account): the same overlay a thread on that account gets.
      // `accounts` is built below; these run per call, after boot.
      accountEnv: (h, id) => accounts.spawnEnv(h === 'claude' ? 'claude-code' : 'codex', { accountId: id }),
      defaultAccount: (h) => accounts.defaultId(h),
      // `auto` (coach spec section 5): the signed-in account with the most weekly room, from the usage gauge.
      pickAuto: async () => pickHarness(usageGauge.summary(), await assistSignedIn()),
    });
  /** Every account assist may sign in as, the default of each harness first; OpenRouter last, when a key is set. */
  const assistSignedIn = async (): Promise<{ harness: AssistHarness; accountId: string }[]> => {
    const out: { harness: AssistHarness; accountId: string }[] = [];
    for (const h of ['claude', 'codex'] as const) {
      const ids = accounts.list(h).map((a) => a.id);
      const def = accounts.defaultId(h);
      // The CLI's own login (`cli`) needs the CLI signed in; an added account needs the CLI installed and its own login.
      const cliOk = (await usable(h, titleCliDeps).catch(() => null)) !== null;
      const installed = (await usable(h, { ...titleCliDeps, signedIn: async () => true }).catch(() => null)) !== null;
      for (const id of [def, ...ids.filter((x) => x !== def)]) {
        const ok = id === 'cli' ? cliOk : installed && (h === 'claude' ? !!accounts.claudeToken(id) : accounts.codexSignedIn(id));
        if (ok) out.push({ harness: h, accountId: id });
      }
    }
    if (await resolveOpenRouterKey?.().catch(() => null)) out.push({ harness: 'openrouter', accountId: 'openrouter' });
    return out;
  };
  plugins.setAssistTotalsProvider((id) => pluginData.assistTotals(db, id));
  const threadAutoNamer = new ThreadAutoNamer(db, broadcaster, {
    getApiKey: () => resolveOpenRouterKey?.() ?? Promise.resolve(null),
    cliTitle: firstTitle([claudeTitleGenerator(titleCliDeps), codexTitleGenerator(titleCliDeps)]),
  });

  // Determine actual server URL after port is known
  const sessionService = new SessionService(db, ptyManager, path.join(dataDir, 'mcp.json'));
  sessionService.setKeyRegistry(keys, { keyDir: path.join(dataDir, 'keys') });
  sessionService.setUserPromptListener((id, text, source) => { if (source === 'user') threadAutoNamer.notifyPrompt(id, text); threadEvents.onPrompt(id, text, source); });
  sessionService.setDaemonPort(preferredPort); // corrected below if the daemon falls back to another port
  // A Claude overseer loads only its own memory folder under this home (overseer memory scope
  // spec 2026-10-07, Unit 1). Only the real daemon sets it; createApp (tests) leaves it unset.
  sessionService.setOverseerMemoryHome(os.homedir());
  const agentService = new AgentService(db, sessionService, broadcaster, path.join(dataDir, 'runs'));
  // Built ahead of rolesService (moved up from its former spot below, alongside the other
  // *Pretty wiring) so it can be handed in as RolesService's optional push dep — backs the
  // 2-consecutive-failed-nights auto-disable Needs-you (Task 7).
  const pushService = new PushService(db, { vapidDir: dataDir });
  const rolesService = new RolesService({ db, agentService, sessionService, pushService });
  agentService.setRoleRunner(rolesService);
  // Wakes watchers on peer status edges (see sessions/watch-dispatcher.ts) — wired as an
  // optional StatusService dependency, same shape as the threadAutoNamer activity callback.
  // A wake and a worker's notice are written to the delivery outbox first, then delivered (W2-C).
  const outbox = createDeliveryOutbox(db, sessionService, buildWatchDeliver(sessionService));
  const watchDispatcher = new WatchDispatcher(db, outbox);
  // Endless Chat hears every status edge here (a thread's error edge reports); its settles
  // come from the settled listener below.
  let onEndlessStatus: ((terminalId: string, status: string) => void) | null = null;
  const statusService = new StatusService(
    db, broadcaster,
    (id) => threadAutoNamer.notifyActivity(id),
    (terminalId, status) => {
      // Endless first, in its own try: a throw in either hook must not drop the other.
      try { onEndlessStatus?.(terminalId, status); } catch (err) { console.warn('[endless] status edge failed:', err); }
      watchDispatcher.onStatus(terminalId, status);
    },
    (id, prompt) => threadAutoNamer.notifyPrompt(id, prompt),
  );
  subscribeDeliveryOutbox(outbox, statusService);
  // Plugins observe hook payloads, spawns and declarations; prompts join the auto-namer's listener below.
  statusService.setHookListener((p, id, payload) => threadEvents.onHookPayload(p, id, payload));
  sessionService.setSpawnListener((id, tools) => threadEvents.onSpawned(id, tools));
  sessionService.setStatusDeclaredListener((id, decl) => threadEvents.onStatus(id, decl));
  sessionService.setPluginInjection((harness, sessionId) => { const inj = plugins.modelInjection(harness); return { ...inj, prompts: [...inj.prompts, ...skills.injection(sessionId, harness)] }; });
  // Hook scripts run on thread events (docs/superpowers/specs/2026-11-07-plugins-design.md, section 3.3).
  const pluginHooks = new PluginHooks(plugins, threadEvents, { api: () => daemonApi });
  plugins.setHookStatsProvider((id) => pluginHooks.stats(id));
  // Workers (spec section 4): one process per enabled plugin with a worker, fed on stdin.
  const pluginWorkers = new PluginWorkers(plugins, threadEvents, { logDir: platform.logDir(), runDir: path.join(dataDir, 'run'), api: () => daemonApi });
  plugins.setWorkerStatsProvider((id) => pluginWorkers.stats(id));
  plugins.setWorkerSync(() => pluginWorkers.sync());
  app.locals.pluginWorkers = pluginWorkers;
  pluginWorkers.sync();
  app.locals.marketplaces = marketplaces;
  app.locals.installer = installer;
  app.locals.skills = skills;
  const harnessManagers = wireHarnesses(sessionService, statusService, db, broadcaster, undefined, threadEvents);
  wireRestoredQuestions(db, sessionService, harnessManagers.values(), statusService); // a pending question survives a restart (W2-C)
  const structuredManager = harnessManagers.get('claude-code')!;
  const extraManagers = new Map([...harnessManagers].filter(([name]) => name !== 'claude-code'));
  agentService.setLifecycleService(statusService);
  statusService.onHarnessCommitted(event => { if (event.type === 'process.exited') rolesService.handleTerminalExit(event.terminalId); });
  sessionService.setTerminalStatusWriter((id, status) => statusService.setTerminalState(id, status));
  const opencodeStructured = extraManagers.get('opencode');
  // Endless Chat (spec 2026-10-13): its own Claude manager, so its turn and compaction
  // processes never reach SessionService's thread listeners.
  const endlessManager = new ClaudeStructuredSessionManager();
  const ledgerService = wireLedger(db, sessionService, broadcaster);
  wireTerminalChanged(sessionService, broadcaster);
  const endless = new EndlessService({
    ledger: ledgerService,
    db, broadcaster, manager: endlessManager,
    chatDir: path.join(dataDir, 'chat'),
    home: os.homedir(),
    limits: limitsFromEnv(process.env.DISPATCH_ENDLESS_LIMITS),
    openRouterKey: () => resolveOpenRouterKey?.() ?? Promise.resolve(null),
    finalOutput: (id) => sessionService.finalOutput(id),
    pendingPermission: (id) => sessionService.getPendingPermission(id),
  });
  // Stage 2: a thread Chat started reports when it settles (finished or asking) or fails.
  endless.setKeyRegistry(keys);
  statusService.addThreadSettledListener(({ terminalId, threadStatus }) => endless.onThreadSettled({ terminalId, threadStatus }));
  onEndlessStatus = (terminalId, status) => endless.onThreadStatus(terminalId, status);

  // Usage-limit auto-resume: a thread an agent CLI stopped for its quota is parked in the db and
  // woken after the reset (limits/service.ts). The managers emit 'usage-limit'; SessionService
  // routes it here. Chat's own turn parks under CHAT_ID and wakes through Chat's retry.
  const usageLimits = new UsageLimitService({
    db,
    markPaused: (id, label) => { if (id !== CHAT_ID) statusService.markScheduled(id, label); },
    wake: (id, text) => sessionService.resumeAfterUsageLimit(id, text),
    note: (id, text, o) => endless.noteLimit(id === CHAT_ID ? null : id, text, o.deliver),
    chat: { isBusy: () => endless.turns.status !== 'idle', wake: () => endless.wakeAfterLimit() },
  });
  sessionService.setUsageLimitService(usageLimits);
  sessionService.setWakeWorkingMarker((id) => statusService.markWorking(id, 'Thinking…'));
  // The account's limit figures for the Details panel: Claude from its stream, Codex from its session file (routes/usage-limits.ts).
  const limitSnapshots = new LimitSnapshots(db);
  // A headless box signs in with an injected token (the CLI's own file does not change), so that token is the account.
  // Which login an account is on, so a figure from one login is never shown as current after a switch
  // (limits/account.ts). `cli`: the CLI's own file or keychain; an added Claude account: its token;
  // an added Codex account: the auth.json in its own folder.
  // Accounts per harness (multi-account spec 2026-11-06); wired to the login flow below.
  const accounts = new AccountsStore(dataDir);
  const limitAccount = (provider: string, accountId = 'cli'): string => {
    if (accountId !== 'cli') {
      if (provider === 'claude-code') return tokenAccountId(accounts.claudeToken(accountId)) || `acct:${accountId}`;
      const dir = accounts.codexHome(accountId);
      return (dir && codexAccountId({ ...process.env, CODEX_HOME: dir })) || `acct:${accountId}`;
    }
    return (provider === 'claude-code' && tokenAccountId(claudeLogin.getToken())) || accountIdFor(provider);
  };
  for (const m of [structuredManager, endlessManager] as import('events').EventEmitter[]) {
    m.on('rate-limit', (id: string, info: unknown) => {
      // A thread with no account of its own runs on the daemon's default env, so its figures belong to the Claude default account.
      const acc = threadAccountId(terminalsDb.getById(db, id)?.config) ?? accounts.defaultId('claude');
      limitSnapshots.record('claude-code', limitAccount('claude-code', acc), parseClaudeRateLimit(info), Date.now(), undefined, false, undefined, acc);
    });
  }
  // The usage gauge (#127): the header chip, the paused banner and the one-push-per-window warning.
  // It hears every recorded snapshot and every pause change, and refreshes Codex on its own tick.
  // Per account (multi-account spec 2026-11-06): the CLI login reads as before; an added Claude
  // account reads with its own token; an added Codex account reads under its own CODEX_HOME.
  const codexEnvFor = (accountId: string): Record<string, string> => {
    const dir = accountId === 'cli' ? null : accounts.codexHome(accountId);
    return { ...inheritedEnv(), ...titleSpawnEnv, ...(dir ? { CODEX_HOME: dir } : {}) };
  };
  const codexRootsFor = (accountId: string) => {
    const dir = accountId === 'cli' ? null : accounts.codexHome(accountId);
    return dir ? { sessions: path.join(dir, 'sessions'), archived: path.join(dir, 'archived_sessions') } : null;
  };
  const refreshCodex = createCodexRefresh(limitSnapshots, {
    accountFor: limitAccount, rootsFor: codexRootsFor,
    codexLoginChangedAt: (accountId) => { const dir = accountId === 'cli' ? null : accounts.codexHome(accountId); return codexLoginChangedAt(dir ? { ...process.env, CODEX_HOME: dir } : process.env); },
  });
  // With no Codex thread of an account active lately, ask Codex itself (codex-poll.ts), signed in as a thread is.
  const pollCodex = createCodexPoll({ snapshots: limitSnapshots, accountFor: limitAccount, env: codexEnvFor });
  // Claude's figures for CLI-only use: a tiny background turn when they go stale (claude-probe.ts).
  // An added account runs it with its own token: its `setup-token` token cannot read the usage endpoint (2026-11-07).
  const probeClaude = createClaudeProbe({
    snapshots: limitSnapshots, accountFor: limitAccount,
    env: (accountId = 'cli') => ({ ...inheritedEnv(), ...titleSpawnEnv, ...(accountId === 'cli' ? {} : accounts.spawnEnv('claude-code', { accountId })) }),
  });
  // Claude's usage as claude.ai shows it (claude-usage.ts): every window, Fable included, and the extra-usage
  // spend. `cli` reads with the CLI's own login (file or keychain); an added account with its saved token.
  // The tiny turn above is the fallback when an account's read fails.
  const readClaudeUsage = createClaudeUsageReader({
    snapshots: limitSnapshots, accountFor: limitAccount,
    token: async (accountId) => (accountId === 'cli' ? readClaudeToken({}) : accounts.claudeToken(accountId)),
  });
  const accountRefs = () => [
    ...accounts.list('claude').map((a) => ({ provider: 'claude-code', accountId: a.id, label: a.label })),
    ...accounts.list('codex').map((a) => ({ provider: 'codex', accountId: a.id, label: a.label })),
  ];
  const usageGauge = new UsageGauge({ db, snapshots: limitSnapshots, broadcast: (e) => broadcaster.broadcast(e), push: pushService, accountFor: limitAccount, accounts: accountRefs, refreshCodex, pollCodex, codexCredits: (accountId) => pollCodex.credits(accountId), claudeCredits: (accountId) => readClaudeUsage.credits(accountId), probeClaude, readClaudeUsage, claudeTokenStamp: (accountId) => accounts.claudeTokenStamp(accountId) });
  accounts.onChange(() => usageGauge.accountsChanged());
  // W1-H: what each Claude sign-in can do for the usage figures rides on the accounts view; "Check again" reads now.
  accounts.setUsageAccessSource((accountId) => usageGauge.claudeUsageAccess(accountId));
  accounts.onCheckUsage((accountId) => usageGauge.checkClaudeNow(accountId));
  limitSnapshots.addRecordListener((provider, accountId) => usageGauge.onRecord(provider, accountId));
  usageLimits.addChangeListener(() => usageGauge.pausesChanged());
  // A finished turn ends a resumed thread's retry chain: CLI threads through the status settle,
  // Chat through its own manager. An owner action on Chat ends its pause.
  statusService.addThreadSettledListener(({ terminalId }) => usageLimits.onTurnSettled(terminalId));
  endlessManager.on('idle', (id: string) => { if (isChatTurnId(id)) usageLimits.onTurnSettled(CHAT_ID); });
  endlessManager.on('failed', (id: string) => { if (isChatTurnId(id)) usageLimits.onTurnEnded(CHAT_ID); });
  endlessManager.on('needs-help', (id: string) => { if (isChatTurnId(id)) usageLimits.onTurnSettled(CHAT_ID); });
  endless.onOwnerAction = () => usageLimits.onUserMessage(CHAT_ID);
  endlessManager.on('usage-limit', (id: string, limit: import('./limits/detect.js').UsageLimit) => {
    if (isChatTurnId(id) && endless.turns.status !== 'idle') usageLimits.park(CHAT_ID, 'claude-code', limit);
  });

  // Fleet totals are a read-only projection of the canonical analytics ledger.
  const usage = new UsageRecorder(db);

  wireThreadSettledPush(db, statusService, pushService);
  wirePtyUsageCapture(db, statusService, sessionService, broadcaster);
  rolesService.wireSettled(statusService);

  // Doppler secrets: token-backed connection + per-spawn injection (DOPPLER_* env +
  // an MCP server) so Claude Code / Codex agents can add & retrieve secrets.
  const secretsService = new SecretsService(dataDir);
  const integrationsService = new IntegrationsService(db, integrationLauncher(dataDir), () => { const st = secretsService.status(); return st.connected && st.enabled; });
  // Terminal-free Claude login (design doc §11.2). Its token is injected below in
  // refreshPtyEnv, so a box authenticated mid-session takes effect on the next spawn
  // without a daemon restart.
  const claudeLogin = new ClaudeLoginService(dataDir);
  // Added Codex accounts sign in with `codex login --device-auth` under the threads' spawn env
  // (PATH with the bundled tools), so it runs the same `codex` the threads do.
  const codexLogin = new CodexLoginService({
    env: () => ({ ...inheritedEnv(), ...titleSpawnEnv }),
    isSignedIn: (home) => fs.existsSync(path.join(home, 'auth.json')),
  });
  // Accounts per harness (multi-account spec 2026-11-06). The single saved login of earlier
  // versions becomes the account `saved`; a login started for a new account lands here, and the
  // profile call fills in its email, account id and plan.
  accounts.migrateSavedClaudeToken(claudeLogin.getToken());
  claudeLogin.onAccountToken = async (token, label, accountId) => {
    // Profile first, so signing an existing account in again updates it (adoptClaudeLoginToken).
    // With an account id ("Sign in again", W1-H) that account's token is replaced in place.
    await adoptClaudeLoginToken(accounts, token, label, fetchClaudeProfile, accountId);
  };
  sessionService.setAccountEnv((type, config) => ({ ...accounts.spawnEnv(type, config), ...secretsService.getThreadTokenEnv(config) }));
  const providerOfType = (type: string): AccountProvider | null => (type === 'claude-code' ? 'claude' : type === 'codex' ? 'codex' : null);
  sessionService.setAccountDirectory({
    has: (type, id) => { const p = providerOfType(type); return p ? accounts.has(p, id) : false; },
    defaultId: (type) => { const p = providerOfType(type); return p ? accounts.defaultId(p) : 'cli'; },
  });
  // Tools brokered by OS, resolved per spawn (design §4.2.1).
  const osConnections = new OsConnectionsProvider();
  const toolsBase = path.join(dataDir, 'tools');
  // Whether each bundled CLI can really sign in from a thread: runs its authCheck with the
  // thread spawn env (kept current by refreshPtyEnv below), not this daemon's bare env.
  const toolsAuth = new ToolAuthProber({ base: toolsBase });
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
  sessionService.setToolsAwareness(() => {
    // Sync, so it can only serve the cache; a stale one is refreshed behind this spawn.
    if (toolsAuth.isStale()) void toolsAuth.refresh();
    return awarenessNote(toolStatuses({ base: toolsBase, env: toolsAuth.threadEnv(), checks: toolsAuth.snapshot().results }));
  });
  let effectiveShimEnv = browserShimEnv;
  const agentSummaryHook = installAgentSummaryHook(dataDir);
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
    const spawnEnv: Record<string, string> = {
      ...effectiveShimEnv,
      // Not a secret: the address that a thread key may be sent to. The key itself is never here.
      DISPATCH_API: daemonApi,
      ...claudeLogin.getSpawnEnv(),
      ...osConnections.getSpawnEnv(),
      ...secretsService.getBaseSpawnEnv(),
      ...getToolsSpawnEnv({ base: toolsBase }),
    };
    // Each of those builds its own PATH off process.env.PATH, so the last spread wins
    // and the earlier prefixes are lost. Re-assert the shim's bin dir explicitly — without
    // it $BROWSER points at a `dispatch-open` that is not on PATH, and the whole
    // browser-auth relay silently does nothing. On a hosted box that relay is the ONLY
    // route an OAuth URL has to the person signing in: there is no local browser.
    spawnEnv.PATH = withShimPath(dataDir, spawnEnv.PATH);
    // Every Claude Code thread preloads the agent_summary off-switch (claude-agent-summary.ts).
    // Settings → Agents → Claude Code turns it off; the PUT re-runs this refresh.
    const bunOptions = withAgentSummaryPreload(process.env.BUN_OPTIONS, skipClaudeAgentSummaries(db) ? agentSummaryHook : null);
    if (bunOptions) spawnEnv.BUN_OPTIONS = bunOptions;
    toolsAuth.setSpawnEnv(spawnEnv);
    // The Claude version check reads the same `claude` the agents will run.
    setClaudeProbeEnv(spawnEnv);
    // The sign-in check that gates new threads asks the CLI under the same env, so
    // Dispatch's saved Claude token counts even when the CLI's own login has expired.
    setProviderProbeEnv(spawnEnv);
    titleSpawnEnv = spawnEnv;
    ptyManager.setDefaultEnv(spawnEnv);
    structuredManager.setDefaultEnv(spawnEnv);
    endlessManager.setDefaultEnv(spawnEnv);
    // The ACP children (Grok, OpenCode) run real tools directly (no app-server
    // indirection), so they need the same spawn env a PTY thread gets — secrets, bundled
    // tools, the browser shim.
    for (const manager of extraManagers.values()) manager.setDefaultEnv(spawnEnv);
    refreshOpencodeKeyEnv(spawnEnv);
  };
  secretsService.onChange(refreshPtyEnv);
  // A new login reaches every spawn env first; then Chat's failed summaries run again with it.
  claudeLogin.onChange(() => { refreshPtyEnv(); endless.retryCompaction(); });
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
  // CLI (PTY) Claude and Codex threads: the usage-limit banner, once the terminal has gone quiet.
  // A banner parks only a terminal of the CLI that prints it (a Codex banner quoted in a Claude
  // thread, or in a plain shell, is not a stop).
  const ptyTypes = new Map<string, string>(); // terminal id -> type, read once per terminal (this runs on every output chunk)
  const ptyLimits = new PtyLimitWatcher({
    isIdle: (id) => terminalMonitor.getStatus(id)?.activity !== 'busy',
    providerOf: (id) => {
      let type = ptyTypes.get(id);
      if (type === undefined) {
        type = terminalsDb.getById(db, id)?.type;
        if (type !== undefined) ptyTypes.set(id, type);
      }
      return type;
    },
    onLimit: (id, limit, provider) => {
      const t = terminalsDb.getById(db, id);
      if (t && !t.archived_at && t.type === provider) usageLimits.park(id, t.type, limit);
    },
  });
  ptyManager.on('data', (id: string, data: Buffer) => {
    terminalMonitor.onOutput(id, data);
    agentService.onRunnerData(id, data);
    ptyLimits.feed(id, data.toString('utf8'));
  });
  ptyManager.on('exit', (id: string) => { ptyLimits.forget(id); ptyTypes.delete(id); });
  usageLimits.addTouchListener((id) => ptyLimits.forget(id));
  // A wake clears the watcher's memory of the thread: a banner with no reset time is otherwise ignored for 35 minutes as a repaint, but the retry comes at 30, so a repeat stop right after a wake would be missed.
  usageLimits.addWakeListener((id) => ptyLimits.forget(id));

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

  // Mount routes (the one list, shared with createApp)
  mountApiRoutes(app, {
    db, sessionService, statusService, agentService, rolesService, authRequestService,
    claudeLogin, codexLogin, accounts, secretsService, integrationsService, pushService, ledgerService,
    toolsBase, toolsAuth, dataDir, repoRoot: resolveRepoRoot(),
    broadcaster, plugins, assistRunner, terminalsBroadcaster: broadcaster, noCredentialStats, pairCodes, devices, cookiePath: BASE_PATH || '/',
    reachableAddresses: async () => {
      const me = await tailscaleAccess.self().catch(() => null);
      return reachableAddresses(me?.ips ?? [], platform.flavor === 'wsl');
    }, refreshPtyEnv, endless,
    usageLimits: { snapshots: limitSnapshots, accountFor: limitAccount, refreshCodex, summary: () => usageGauge.summary(), onSettingsChange: () => usageGauge.settingsChanged(), useResetCredit: (p: string, creditId?: string, accountId?: string) => (p === 'codex' ? pollCodex.useCredit(creditId, accountId) : Promise.resolve(null)) },
    watchCatchUp: (id) => watchDispatcher.catchUp(id), outbox,
  });

  // Serve the built web client (single-origin) when a build is present.
  // SPA fallback returns index.html for any non-/api, non-WS GET.
  const webDist = process.env.DISPATCH_WEB_DIST
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  // Plugin files, with or without a web build (the dev server proxies /plugins here).
  app.get('/plugins/:id/*', ...pluginAssetHandler(plugins));
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    // index.html is transformed (not sent as a file) so <base href> matches the mount
    // prefix. It is read again when the file changes (one stat per request): a web rebuild
    // gives new script names, and a page must not get the names of a build that is gone.
    const indexHtml = createIndexProvider(path.join(webDist, 'index.html'), BASE_PATH);
    const sendIndex = (_req: express.Request, res: express.Response) => {
      res.type('html').send(indexHtml());
    };
    app.get('/icons/:name', publicRoute, customIconHandler(dataDir));
    // Build files: content-hashed, so compressed once and cached forever (web-assets.ts).
    app.use('/assets', compressedAssets(path.join(webDist, 'assets')));
    app.use(express.static(webDist, {
      index: false,
      setHeaders: (res, file) => { if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', IMMUTABLE); },
    }));
    app.get(/^\/(?!api\/).*/, publicRoute, sendIndex);
    console.log(`Serving web client from ${webDist}${BASE_PATH ? ` under ${BASE_PATH}` : ''}`);
  }
  // Last: every error that no route answered becomes a JSON status and message, never a stack trace.
  app.use(jsonErrorHandler);

  // Handle HTTP upgrade for WebSocket connections
  server.on('upgrade', (request, socket, head) => {
    // The gate is async (it may ask the tailscale CLI), so the whole handler waits for it.
    // A socket that is not admitted gets an HTTP status line and is closed.
    void handleUpgrade(request, socket, head).catch(() => socket.destroy());
  });
  // Open WebSockets by device id. A revoke destroys them: the cookie is checked only at connect.
  const deviceSockets = new Map<string, Set<import('node:stream').Duplex>>();
  const legacySockets = new Map<import('node:stream').Duplex, string>();
  const trackDeviceSocket = (id: string, socket: import('node:stream').Duplex) => {
    let set = deviceSockets.get(id);
    if (!set) deviceSockets.set(id, set = new Set());
    set.add(socket);
    socket.once('close', () => { set!.delete(socket); if (!set!.size) deviceSockets.delete(id); });
  };
  devices?.onAdopt((key, id) => {
    for (const [s, k] of legacySockets) if (k === key) { legacySockets.delete(s); trackDeviceSocket(id, s); }
  });
  devices?.onEndLegacy(() => { for (const s of legacySockets.keys()) s.destroy(); legacySockets.clear(); });
  devices?.onRevoke((id) => { for (const s of deviceSockets.get(id) ?? []) s.destroy(); deviceSockets.delete(id); });
  const handleUpgrade = async (request: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    // Node removes its own error listener before 'upgrade' fires, and ws adds one only inside
    // handleUpgrade. The gate below awaits (it may run the tailscale CLI), so without this a
    // peer reset in that window is an uncaught ECONNRESET that kills the daemon.
    socket.on('error', () => socket.destroy());
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
    // SEC-05 middle: the owner's credential, or a browser handshake (which always carries Origin), may type
    // into a terminal. A credential-free program may watch it. Keys never reach here (refused below).
    let allowInput = true;
    if (accessGate) {
      const d = await accessGate.upgradeDecision(request, url);
      if (socket.destroyed) return;
      if (d.ok) allowInput = d.via === 'credential' || looksLikeBrowser(request.headers);
      if (!d.ok) {
        socket.end(`HTTP/1.1 ${d.status} ${d.status === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        return;
      }
      // Remember which device owns this socket, so revoking the device closes it.
      let deviceId = d.credential?.kind === 'cookie' ? d.credential.deviceId : null;
      if (d.credential?.kind === 'cookie' && !deviceId && devices) {
        // The shared cookie from before the device list. If this browser was just made a device, the socket
        // belongs to it. If not, hold it by browser+address: the browser's next HTTP request adopts it
        // (onAdopt below), and "end older sign-ins" closes whatever is still held here.
        const key = accessGate.legacyKey(request);
        deviceId = devices.recentAdoption(key);
        if (!deviceId) {
          legacySockets.set(socket, key);
          socket.once('close', () => legacySockets.delete(socket));
        }
      }
      if (deviceId) trackDeviceSocket(deviceId, socket);
    }
    // No key opens a WebSocket (spec 6.4): the browser owns these sockets.
    if (refuseKeyUpgrade(request)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }

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
          (tid) => sessionService.activeModel(tid),
          (tid) => sessionService.getPendingPermission(tid),
        );
      });
    } else if (url.match(/\/api\/terminals\/[^/]+\/ws/) || url.match(/\/api\/sessions\/[^/]+\/terminal/)) {
      terminalWss.handleUpgrade(request, socket, head, (ws) => {
        handleTerminalConnection(ws, request, ptyManager, sessionService, terminalMonitor, statusService, allowInput);
      });
    } else if (url === '/api/events') {
      eventsWss.handleUpgrade(request, socket, head, (ws) => {
        answerEventsPing(ws);
        eventsWss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  };

  // Listen on the port
  const port = await new Promise<number>((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        if (options?.allowRandomPortFallback) {
          listenOn(server, 0, bindHost, () => {
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

    // DISPATCH_BIND unset: every interface, the same call as before. Set: that address only (platform/bind.ts).
    listenOn(server, preferredPort, bindHost, () => {
      resolve(preferredPort);
    });
  });

  // Hold 127.0.0.1 and ::1 on the port too, so no other process can take localhost from us
  // (platform/loopback-guard.ts). With DISPATCH_BIND the daemon may hold one of them itself: that one is skipped.
  // The other is still held, because threads, hooks and the CLI call the daemon on 127.0.0.1.
  const boundAddress = bindHost === undefined ? null : ((server.address() as AddressInfo | null)?.address ?? bindHost);
  const loopbackGuards = await guardLoopback(server, port, undefined, boundAddress ? [boundAddress] : []);
  if (boundAddress) console.log(`[dispatch] DISPATCH_BIND: listens on ${boundAddress} and on the loopback addresses only, not on all interfaces.`);
  sessionService.setDaemonPort(port);
  sessionService.setDaemonApi(`http://127.0.0.1:${port}${BASE_PATH}`);

  // Record our own pid so daemon controllers (e.g. WSL's restart()) can find and signal this
  // process without an OS service manager. Only now that the port is bound: a duplicate launch
  // that loses the port race exits above and must not overwrite the live daemon's pid (#56).
  writeOwnPid(dataDir);
  writeListenInfo(dataDir, { port, bind: boundAddress }); // "dispatch status" prints it

  if (port !== preferredPort) {
    daemonApi = `http://127.0.0.1:${port}${BASE_PATH}`;
    effectiveShimEnv = platform.installBrowserShim({
      dataDir,
      serverUrl: daemonApi,
    });
    refreshPtyEnv();
  }

  // Store port in app state
  appState.set(db, 'port', String(port));
  // Endless Chat needs the real port for its memory MCP server config. A failed start
  // logs and disables only the chat (its routes answer 503); the daemon keeps running.
  startEndless(endless, port);

  // Status hooks: tell SessionService how to make spawned agents phone home with
  // lifecycle events (Claude hooks settings file + Codex notify helper).
  sessionService.setStatusContext({
    serverUrl: `http://127.0.0.1:${port}${BASE_PATH}`,
    hooksDir: path.join(dataDir, 'hooks'),
    codexHelperPath: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/codex-notify.mjs'),
    grokHelperPath: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/grok-hook.mjs'),
  });

  console.log(`Dispatch server listening on port ${port}`);
  if (accessGate) {
    console.log('Network: other devices need the access token (run "dispatch access"). Tailscale devices on your own account are allowed.');
  }

  // Same idea for model capabilities: the spawn path is sync and reads caches only, so load
  // the OpenRouter and models.dev catalogs once now. A chat-only model resumed right after
  // boot then gets its tools turned off instead of failing its first turn.
  void warmModelCapabilities();
  // Same for the installed Claude Code version: it decides whether a spawn hands Claude its
  // appended system prompt in a private file or as command-line text (claude-prompt-file.ts).
  void warmClaudeVersion().then(() => prunePromptFiles());

  // Prime the brokered-tool cache so the FIRST spawn after boot already has tools
  // (getServerSpecs is sync, so it can only ever serve a cached answer).
  void osConnections.refresh().then((s) => {
    if (osConnections.enabled) {
      console.log(`OS tools: ${s.servers.length} server(s), reachable=${s.reachable}`);
    }
  });
  // First CLI auth-check pass, now the thread spawn env is final (the port fallback above can
  // still change it). Non-blocking; the Tools page and the awareness note read its cache.
  void toolsAuth.refresh();

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
  usageLimits.restore();
  usageLimits.start();
  usageGauge.start();
  void sessionService.kickstartInterruptedAgents()
    .then(({ kicked, skipped, completed }) => {
      if (kicked.length) console.log(`Kickstart: resumed ${kicked.length} interrupted thread(s); skipped ${skipped.length}`);
      // A Chat thread whose turn completed while no one listened owes Chat its report.
      endless.reportCompletedAtBoot(completed);
    })
    .catch((err) => console.error('kickstart failed', err))
    .finally(() => {
      try {
        const alive = (id: string) => ptyManager.isAlive(id) || !!sessionService.structuredManagerForTerminal(id)?.isAlive(id);
        // W2-C: a scheduled wake that the restart killed is flagged, and a thread that waits on a saved
        // question keeps waiting: the process check below must not turn it into an error, nor close its run.
        const reconciled = reconcileAtBoot({ db, isAlive: alive, markIdle: (id, activity) => statusService.markIdle(id, activity), outbox });
        if (reconciled.lostWakes.length) console.log(`Flagged ${reconciled.lostWakes.length} scheduled wake(s) that the restart lost`);
        if (reconciled.restoredQuestions.length) console.log(`Kept ${reconciled.restoredQuestions.length} pending question(s) through the restart`);
        const waitsOnQuestion = new Set(reconciled.restoredQuestions);
        const aliveOrWaiting = (id: string) => alive(id) || waitsOnQuestion.has(id);
        statusService.reconcileProcesses(aliveOrWaiting);
        // Runs that the restart left open: closed here, so their schedules can fire again (W1-D).
        // After the kickstart and the process check, so a thread that runs again keeps its run.
        const orphaned = agentService.reconcileRunsAtBoot(aliveOrWaiting);
        if (orphaned.length) console.log(`Closed ${orphaned.length} run(s) that the restart left open`);
        // Old per-thread MCP files: removed once the threads that will run again have rewritten theirs.
        const swept = sweepThreadMcpConfigs(dataDir, alive);
        if (swept) console.log(`Removed ${swept} stale thread MCP config file(s)`);
        // Key files and key-related config of threads that are gone (named files only).
        const sweptKeys = sweepThreadKeyFiles(dataDir, alive);
        if (sweptKeys) console.log(`Removed ${sweptKeys} stale thread key file(s)`);
        // The messages that waited through the restart (W2-C). After the kickstart, so a thread that runs again takes its own.
        const flushed = flushOutboxAtBoot(outbox);
        if (flushed.delivered) console.log(`Delivered ${flushed.delivered} message(s) that waited in the outbox`);
      }
      finally { setTimeout(() => endless.endBoot(), 1000).unref(); }
    });

  threadAutoNamer.resumePending();

  // Start PTY timing loop for Codex-style providers
  const ptyTimingInterval = startPtyTimingLoop(db, ptyManager, broadcaster, undefined, statusService);
  // Poll GitHub Releases for a newer version than what's running (immediately, then ~45 min)
  // An update that restarted this daemon is done: the update window shows "Updated to …".
  finishRestartedUpdate(dataDir, getRunningVersion());
  const updateCheckInterval = startUpdateCheckLoop(db, broadcaster);
  // Anonymous usage report: 60 s after boot, then an hourly check (Settings → About & updates switch).
  const telemetryLoop = startTelemetryLoop(db);
  // Stall watchdog (W1-D): flags a working thread that sent no frame for 10 minutes
  // (DISPATCH_STALL_MINUTES). It only flags. It rides the scheduler tick below; it has no timer.
  const stallWatchdog = createDaemonStallWatchdog({
    db, broadcaster,
    lastFrameAt: (id) => sessionService.structuredManagerForTerminal(id)?.lastFrameAt?.(id) ?? ptyManager.lastOutputAt(id),
  });
  app.locals.stallWatchdog = stallWatchdog; // GET /api/terminals/stalls reads it
  const agentSchedulerInterval = setInterval(() => {
    try {
      agentService.processDueRuns();
    } catch (err) {
      console.error(err);
    }
    try {
      stallWatchdog.tick();
    } catch (err) {
      console.error('[stall] tick failed:', err);
    }
  }, 30_000);

  // Auto-archive sweep — prunes opted-in threads that have gone idle past their
  // deadline. Cheap: a full scan of a small table (terminals) once a minute — no
  // index backs this, but the table stays small enough that it doesn't matter.
  const autoArchiveInterval = startAutoArchiveLoop(db, sessionService, broadcaster);
  // Interim recap sweep (structured-recap spec, Unit 5): one notice to an overseer whose
  // agents still work 20 minutes after a busy Finished notice. The due time is in the DB.
  const interimRecapInterval = startInterimRecapLoop(db, sessionService);

  // Graceful shutdown
  let shuttingDown = false;
  const cleanup = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Shutting down Dispatch server...');
    sessionService.revokeEveryKey(); // the sticky Codex Pretty keys end with the daemon
    clearInterval(ptyTimingInterval);
    clearInterval(updateCheckInterval);
    for (const g of loopbackGuards) g.close();
    telemetryLoop.stop();
    plugins.stop();
    pluginHooks.stop();
    void pluginWorkers.stop();
    clearInterval(marketplaceCheck);
    clearTimeout(marketplaceFirstCheck);
    clearInterval(agentSchedulerInterval);
    clearInterval(autoArchiveInterval);
    clearInterval(interimRecapInterval);
    clearInterval(heartbeat);
    usageLimits.stop();
    usageGauge.stop();
    boxHeartbeat.stop();
    threadAutoNamer.dispose();
    endless.stop();
    endlessManager.killAll();
    ptyManager.killAll();
    // Each manager kill settles its thread to `waiting` synchronously; keep the mid-turn overseer
    // threads `working` so the next boot's kickstart resumes them.
    sessionService.shutdownPreservingInterruptedTurns(() => {
      structuredManager.killAll();
      for (const manager of extraManagers.values()) manager.killAll();
    });
    // WebSocketServer.close() stops upgrades but leaves connected browsers alive.
    // Those upgraded sockets keep Node running forever, so WSL's updater times out
    // waiting for this process to exit. Disconnect them explicitly before closing.
    for (const wss of [eventsWss, terminalWss, structuredWss]) {
      for (const client of wss.clients) client.terminate();
      wss.close();
    }
    server.close();
    server.closeAllConnections();
    db.close();
    removeOwnPid(dataDir); // only if still ours: a newer daemon may own the file by now
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  return { port, cleanup, keys };
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
