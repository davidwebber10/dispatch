/**
 * The one composition root of the daemon (W3-A of the 2026-11-09 engineering program).
 *
 * `buildDaemon` builds every service and the Express app. `createApp` (tests) and `startServer` (the
 * daemon) both call it, so a wire cannot exist in one and be absent from the other. The differences
 * between a test build and the daemon are inputs: the gate (`auth`), calls that leave the process
 * (`network`), repeating jobs (`timers`), and the facts of a real process (`port`, `shimEnv`; `startServer` also sets the home folder of the overseer memory).
 *
 * The build itself starts nothing: no listener, no interval, no recovery. The caller does that:
 *   attach(server) → listen → listening(port) → bootRecover() → startTimers() … stop().
 */
import { wireJournal } from '../journal/wire.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type http from 'http';
import { fileURLToPath } from 'url';
import express from 'express';
import type Database from 'better-sqlite3';
import * as pendingQuestionsDb from '../db/pending-questions.js';
import * as terminalsDb from '../db/terminals.js';
import * as appState from '../db/app-state.js';
import * as usageDb from '../db/usage.js';
import type { SessionService } from '../sessions/service.js';
import { PTYManager } from '../pty/manager.js';
import { AgentService } from '../agents/service.js';
import { createDaemonStallWatchdog } from '../runtime/stall-watchdog.js';
import type { StallWatchdog } from '../runtime/stall-watchdog.js';
import { RolesService } from '../roles/service.js';
import { AuthRequestService } from '../auth/service.js';
import { ClaudeLoginService } from '../auth/claude-login.js';
import { CodexLoginService } from '../auth/codex-login.js';
import { AccountsStore, adoptClaudeLoginToken, type AccountProvider } from '../auth/accounts.js';
import type { KeyRegistry } from '../auth/principals.js';
import type { AccessGate, GateDeps } from '../auth/access-gate.js';
import type { PairCodes } from '../auth/pair-code.js';
import type { DeviceStore } from '../auth/devices.js';
import type { NoCredentialStats } from '../auth/no-credential-stats.js';
import type { TailscaleAccess } from '../auth/tailscale-access.js';
import { securityHeaders } from '../auth/security-headers.js';
import { mountApiRoutes, type ApiRouteDeps } from '../server-routes.js';
import { jsonErrorHandler } from '../http/error-handler.js';
import { createJsonBody } from '../http/json-body.js';
import { jsonCompression } from '../http/compress.js';
import { OsConnectionsProvider } from '../integrations/os-provider.js';
import { createOsToolsRouter, osToolsServerSpec } from '../os/tools-proxy.js';
import { ClaudeCliLogin, planOf } from '../auth/claude-cli-login.js';
import { useCleanClaudeLogin, isHostedBox } from '../os/hosted-mode.js';
import { wireStopOnAuthFailure } from '../os/auth-stop.js';
import { createApprovalsRouter } from '../os/approvals-routes.js';
import { setProfileSource, envProfile } from '../os/profile.js';
import { IntegrationsService, type IntegrationLauncher } from '../integrations/service.js';
import { HeartbeatService } from '../platform/heartbeat.js';
import { inheritedEnv } from '../platform/inherited-env.js';
import { platform } from '../platform/index.js';
import { UsageRecorder } from '../usage/recorder.js';
import { closeInterruptedTurns } from '../analytics/recorder.js';
import { attachPtyCapture } from '../analytics/pty-capture.js';
import { trackingStartedAt } from '../routes/analytics.js';
import { opencodeKeySecretName } from '../settings/harness-settings.js';
import { toolStatuses, awarenessNote } from '../tools/status.js';
import { ToolAuthProber } from '../tools/auth-probe.js';
import { SecretsService } from '../secrets/service.js';
import { PushService } from '../push/service.js';
import { wireThreadSettledPush } from '../push/notify.js';
import { StatusService } from '../status/service.js';
import { createEventsBroadcaster, type EventBroadcaster } from '../ws/events.js';
import { ClaudeStructuredSessionManager, type IStructuredManager } from '../structured/manager.js';
import type { UsageLimitService } from '../limits/service.js';
import type { LimitSnapshots } from '../limits/snapshot.js';
import type { UsageGauge } from '../limits/gauge.js';
import { fetchClaudeProfile } from '../limits/claude-usage.js';
import type { TerminalMonitor } from '../terminal-monitor.js';
import { ThreadAutoNamer } from '../sessions/thread-auto-namer.js';
import { claudeTitleGenerator, codexTitleGenerator, firstTitle, usable } from '../sessions/cli-namer.js';
import { pickHarness } from '../plugins/assist-share.js';
import { getRunningVersion } from '../update/version.js';
import type { PluginRegistry } from '../plugins/registry.js';
import type { ThreadEvents } from '../plugins/thread-events.js';
import type { PluginHooks } from '../plugins/hooks.js';
import type { PluginWorkers } from '../plugins/workers.js';
import type { MarketplaceService } from '../plugins/marketplaces.js';
import type { PluginInstaller } from '../plugins/installer.js';
import type { SkillsService } from '../plugins/skills.js';
import { createAssistRunner, commandAssistRunner, type AssistRunner, type AssistHarness } from '../assist/run.js';
import { LedgerService } from '../overseer/ledger-service.js';
import { WatchDispatcher } from '../sessions/watch-dispatcher.js';
import type { DeliveryOutbox } from '../delivery/outbox.js';
import { createDeliveryOutbox, subscribeDeliveryOutbox } from '../delivery/wiring.js';
import { wireRestoredQuestions } from '../sessions/boot-reconcile.js';
import { EndlessService, limitsFromEnv, startEndless } from '../endless/service.js';
import { normalizeBasePath, stripBasePath } from './base-path.js';
import { NoopPTYManager, type PtyLike } from './noop-pty.js';
import { wireAuth } from './wire-auth.js';
import { wirePlugins } from './wire-plugins.js';
import { buildWatchDeliver, createSessionService, wireHarnesses, wireSessionService } from './wire-harnesses.js';
import { wireLimits } from './wire-limits.js';
import { wirePty, wireSpawnEnv } from './wire-pty.js';
import { createDaemonSockets, createUpgradeHandler, type DaemonSockets } from './sockets.js';
import { defaultWebDist, mountWeb } from './web.js';
import { daemonTimers, startDaemonTimers } from './timers.js';
import { runBootRecovery } from './boot-recover.js';

export { NoopPTYManager, type PtyLike };

export interface BuildDaemonOptions {
  db: Database.Database;
  /** The data directory (`~/.dispatch` for the daemon): Doppler files, plugins, keys, accounts. */
  dataDir: string;
  /** Default: `process.env`. Read for DISPATCH_BASE_PATH, DISPATCH_BOX_TOKEN, DISPATCH_WEB_DIST and the like. */
  env?: NodeJS.ProcessEnv;
  /** Default: `Date.now`. Given to the gate, the stall watchdog and the usage-limit services. */
  clock?: () => number;
  /** `gate` (default): the request gate of the daemon. `open`: no gate; a caller with no key is the owner (tests). */
  auth?: 'open' | 'gate';
  /** Structured managers by provider name, in place of the real ones (no CLI runs). Must include `claude-code`. */
  managers?: Partial<Record<string, IStructuredManager>>;
  /** Default: a real PTYManager. Tests pass `new NoopPTYManager()`. */
  pty?: PtyLike;
  /**
   * Default true. False: the build makes no call that leaves the process on its own: no account read from
   * Anthropic or the Codex CLI, no title or assist model, no tailscale CLI, no CLI auth probe, no update,
   * telemetry or marketplace check.
   */
  network?: boolean;
  /** Default true. False: `startTimers()` starts nothing, and the plugin workers keep no schedule tick. */
  timers?: boolean;
  /** The built web client. Default: DISPATCH_WEB_DIST or `packages/web/dist`. null: serve no web client. */
  webDist?: string | null;

  // Facts of a real daemon process. A test build has none of them.
  /** The port that the daemon will ask for. Threads are told this address until `listening()` corrects it. */
  port?: number;
  /** The env of the installed browser shim (platform.installBrowserShim). */
  shimEnv?: Record<string, string>;

  // Test seams, as `createApp` always had them.
  /** Directory for bundled CLI tools (defaults to <dataDir>/tools). */
  toolsDir?: string;
  /** The plugins folder (defaults to <dataDir>/plugins). */
  pluginsDir?: string;
  /** The bundled plugins folder. Default: <repo>/packages/plugins. null: none. */
  bundledDir?: string | null;
  /** Model assist for plugins. Default: the signed-in CLIs with the network, else none. */
  assistRunner?: AssistRunner | null;
  /** A pre-built SecretsService (a fake Doppler client). */
  secretsService?: SecretsService;
  /** Spawn this in place of the real `claude` (fake-claude). */
  structuredCommand?: { command: string; args: string[] };
  /** The key registry (tests mint keys through it). Exposed as `app.locals.keys`. */
  keys?: KeyRegistry;
  /** A stand-in for the Chat service that the `/api/endless` routes use. */
  endless?: EndlessService;
  /** A stand-in for what the `/api/usage-limits` routes use. */
  usageLimits?: ApiRouteDeps['usageLimits'];
  /** The accounts that the plugin assist route knows. */
  assistAccounts?: ApiRouteDeps['assistAccounts'];
  /** The Cloudflare Access verifier of the gate (tests pass one with a fake key fetch). */
  cfAccess?: GateDeps['cfAccess'];
  /** The tailscale reader of the gate. */
  tailscale?: TailscaleAccess;
}

/** Every service of the daemon, by name. W3-B takes the constructor inputs of the SessionService parts from here. */
export interface DaemonServices {
  db: Database.Database;
  dataDir: string;
  // Auth
  keys: KeyRegistry;
  noCredentialStats: NoCredentialStats;
  accessGate: AccessGate | undefined;
  pairCodes: PairCodes | undefined;
  devices: DeviceStore | undefined;
  authRequestService: AuthRequestService;
  claudeLogin: ClaudeLoginService;
  codexLogin: CodexLoginService;
  accounts: AccountsStore;
  // Sockets and events
  sockets: DaemonSockets;
  broadcaster: EventBroadcaster;
  // Threads
  ptyManager: PtyLike;
  sessionService: SessionService;
  statusService: StatusService;
  /** Every structured manager, by provider name. */
  harnessManagers: Map<string, IStructuredManager>;
  /** The Claude manager of the threads. */
  structuredManager: IStructuredManager;
  terminalMonitor: TerminalMonitor;
  threadAutoNamer: ThreadAutoNamer;
  stallWatchdog: StallWatchdog;
  // Agents and roles
  agentService: AgentService;
  rolesService: RolesService;
  // Delivery
  outbox: DeliveryOutbox;
  watchDispatcher: WatchDispatcher;
  ledgerService: LedgerService;
  pushService: PushService;
  // Chat
  endless: EndlessService;
  endlessManager: IStructuredManager;
  // Limits and usage
  usageLimits: UsageLimitService;
  limitSnapshots: LimitSnapshots;
  usageGauge: UsageGauge;
  usage: UsageRecorder;
  boxHeartbeat: HeartbeatService;
  // Secrets, integrations and tools
  secretsService: SecretsService;
  integrationsService: IntegrationsService;
  osConnections: OsConnectionsProvider;
  toolsAuth: ToolAuthProber;
  /** Build the spawn env of the threads again (after a secrets, sign-in or settings change). */
  refreshSpawnEnv: () => void;
  // Plugins
  plugins: PluginRegistry;
  marketplaces: MarketplaceService;
  installer: PluginInstaller;
  skills: SkillsService;
  threadEvents: ThreadEvents;
  pluginHooks: PluginHooks;
  pluginWorkers: PluginWorkers;
  assistRunner: AssistRunner | null;
}

export interface Daemon {
  app: express.Express;
  services: DaemonServices;
  /** The mount prefix of the app (DISPATCH_BASE_PATH), '' for none. */
  basePath: string;
  /** The folder of the web client that the app serves; null when it serves none. */
  webDist: string | null;
  /** Route the WebSocket upgrades of this HTTP server to the daemon. `stop()` closes the server. */
  attach(server: http.Server): void;
  /**
   * The daemon listens on `port`: threads, hooks and Chat are told the address, and the port is saved.
   * `shimEnv`: the env of a browser shim that was installed again for a port other than the one asked for.
   */
  listening(port: number, update?: { shimEnv?: Record<string, string> }): void;
  /** Start every repeating job (daemon/timers.ts). The answer ends them; `stop()` does too. With `timers: false` it starts nothing. */
  startTimers(): () => void;
  /** Recover from the last shutdown: parked threads, interrupted turns, dead processes, the outbox. */
  bootRecover(opts?: { settleMs?: number }): Promise<void>;
  /** End the timers, the processes, the sockets and the attached servers. The database stays open: its owner closes it. */
  stop(): void;
}

/** Repo root (the same from src/ in dev and from dist/ once built: both sit at the same depth under packages/core). */
export function resolveRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
}

/**
 * The integration launcher (integrations/launcher.ts) for integrations with `${NAME}` refs,
 * reading the Doppler connection saved in `secretsDir` — the SecretsService's own dir. Null
 * when the compiled launcher.js isn't there (a tsx dev run), so those integrations keep
 * their plain spec rather than point a harness at a missing file.
 */
function integrationLauncher(secretsDir: string): IntegrationLauncher | null {
  const launcherPath = fileURLToPath(new URL('../integrations/launcher.js', import.meta.url));
  return fs.existsSync(launcherPath) ? { nodePath: process.execPath, launcherPath, secretsDir } : null;
}

/**
 * The analytics boot steps, run once per build before any route is mounted.
 *
 * `trackingStartedAt` belongs HERE, not on the first request to /api/analytics:
 * stamped lazily on first read, it would record "the first time someone opened
 * the Analytics view", not the instant recording actually began.
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
 * `isStructured` is the double-count gate. It must go through `SessionService.isStructuredTerminal`,
 * which checks BOTH `config.transport === 'structured'` AND a registered manager for
 * the type — a `transport: 'structured'` Codex row is still a PTY thread when
 * Codex-Pretty is off.
 */
function wirePtyUsageCapture(db: Database.Database, statusService: StatusService, sessionService: SessionService, broadcaster: EventBroadcaster): void {
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
 * The decision ledger's live wiring (pinned card spec 2026-10-08, Unit 3): every write of either
 * LedgerService — the router's, returned here, and the one inside SessionService (the agent
 * owner-decisions capture) — broadcasts `ledger:changed` on the events socket, so the web app's
 * pinned card loads again. A failed broadcast never fails the write (LedgerService catches it).
 */
export function wireLedger(db: Database.Database, sessionService: SessionService, broadcaster: EventBroadcaster): LedgerService {
  const onChange = (sessionId: string) => broadcaster.broadcast({ type: 'ledger:changed', sessionId });
  sessionService.setLedgerChangeListener(onChange);
  return new LedgerService(db, { onChange });
}

function validate(opts: BuildDaemonOptions): void {
  const o = opts as Partial<BuildDaemonOptions> | undefined;
  if (!o?.db) throw new Error('buildDaemon: "db" is required (an open better-sqlite3 database).');
  if (!o.db.open) throw new Error('buildDaemon: "db" is closed. Give an open database.');
  if (typeof o.dataDir !== 'string' || !o.dataDir) throw new Error('buildDaemon: "dataDir" is required (the data directory of the daemon).');
}

export function buildDaemon(opts: BuildDaemonOptions): Daemon {
  validate(opts);
  const { db, dataDir } = opts;
  const env = opts.env ?? process.env;
  const network = opts.network ?? true;
  const timersOn = opts.timers ?? true;
  const basePath = normalizeBasePath(env.DISPATCH_BASE_PATH);
  /** Shared secret the router injects on every request to a hosted box. Unset ⇒ open (local). */
  const boxToken = env.DISPATCH_BOX_TOKEN?.trim() || undefined;
  // The daemon's own address for first-party callers (hooks, the shim, MCP helpers): loopback, the
  // bound port and the base path. It is also the only destination that a thread key may be sent to.
  // null until a port is known: a build that never listens tells no thread an address.
  let daemonApi: string | null = opts.port === undefined ? null : `http://127.0.0.1:${opts.port}${basePath}`;
  let shimEnv = opts.shimEnv ?? {};

  // ── The app and the gate ────────────────────────────────────────────────────
  const app = express();
  app.use(securityHeaders);
  // Strip the mount prefix ONCE, before anything routes. Everything downstream —
  // all the route mounts, the static handler, the SPA fallback — keeps its existing
  // root-relative paths and is unaware the app is served under a prefix.
  if (basePath) app.use(stripBasePath(basePath));
  const auth = wireAuth({ db, dataDir, mode: opts.auth ?? 'gate', basePath, boxToken, network, keys: opts.keys, clock: opts.clock, cfAccess: opts.cfAccess, tailscale: opts.tailscale });
  const { keys } = auth;
  app.locals.keys = keys;
  auth.install(app);
  app.use(createJsonBody()); // 1 MiB; the few routes with big payloads get the large cap (http/json-body.ts)
  app.use(jsonCompression()); // API JSON over 1 KB goes out as br or gzip (http/compress.ts)

  // ── Sockets, events and plugins ─────────────────────────────────────────────
  const sockets = createDaemonSockets();
  const broadcaster = createEventsBroadcaster(sockets.events);
  const ptyManager: PtyLike = opts.pty ?? new PTYManager(shimEnv);
  const pluginsDir = opts.pluginsDir ?? path.join(dataDir, 'plugins');
  const bundledDir = opts.bundledDir === undefined ? path.join(resolveRepoRoot(), 'packages', 'plugins') : opts.bundledDir;
  const pluginSvc = wirePlugins({
    db, dataDir, pluginsDir, bundledDir, broadcaster, keys, runningVersion: getRunningVersion(),
    logDir: platform.logDir(), daemonApi: () => daemonApi ?? '', timers: timersOn,
  });
  const { plugins, marketplaces, installer, skills, threadEvents, pluginHooks, pluginWorkers } = pluginSvc;
  Object.assign(app.locals, { plugins, marketplaces, installer, skills, threadEvents, pluginWorkers });
  const authRequestService = new AuthRequestService(broadcaster);

  // ── Titles and model assist: the user's own sign-ins, then OpenRouter ────────
  // Name once from the first submitted user prompt; transcript activity is a legacy
  // fallback. Titles: Claude Haiku via `claude -p`, then Codex, on the user's own sign-ins, and only
  // then OpenRouter (cli-namer.ts). The CLIs run under the thread spawn env, so Dispatch's saved
  // Claude token signs them in like a thread. With no network the thread keeps its prefix-derived name.
  const secretsService = opts.secretsService ?? new SecretsService(dataDir);
  // The OpenCode/OpenRouter key by its CONFIGURED Doppler name, resolved fresh per attempt so key
  // changes apply without a restart. null (not throw) when Doppler isn't connected.
  const resolveOpenRouterKey = async (): Promise<string | null> => {
    if (!network) return null;
    try { return (await secretsService.getSecret(opencodeKeySecretName(db))) ?? null; }
    catch { return null; }
  };
  const accounts = new AccountsStore(dataDir);
  const titleCliDeps = { env: () => ({ ...inheritedEnv(), ...spawnEnv.current() }) };
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
    if (await resolveOpenRouterKey().catch(() => null)) out.push({ harness: 'openrouter', accountId: 'openrouter' });
    return out;
  };
  // Model assist for plugins (spec section 3.4): the same signed-in CLI the titles use, else the OpenRouter key.
  const assistRunner: AssistRunner | null = opts.assistRunner !== undefined ? opts.assistRunner
    : !network ? null
    : env.DISPATCH_ASSIST_COMMAND ? commandAssistRunner(env.DISPATCH_ASSIST_COMMAND)
    : createAssistRunner({
        cli: titleCliDeps, getApiKey: resolveOpenRouterKey,
        // The account a call signs in as (multi-account): the same overlay a thread on that account gets.
        accountEnv: (h, id) => accounts.spawnEnv(h === 'claude' ? 'claude-code' : 'codex', { accountId: id }),
        defaultAccount: (h) => accounts.defaultId(h),
        // `auto` (coach spec section 5): the signed-in account with the most weekly room, from the usage gauge.
        pickAuto: async () => pickHarness(limits.usageGauge.summary(), await assistSignedIn()),
      });
  const threadAutoNamer = new ThreadAutoNamer(db, broadcaster, network
    ? { getApiKey: resolveOpenRouterKey, cliTitle: firstTitle([claudeTitleGenerator(titleCliDeps), codexTitleGenerator(titleCliDeps)]) }
    : {});

  // ── Threads: SessionService, agents, roles, delivery, status ────────────────
  const sessionService = createSessionService({ db, pty: ptyManager, mcpConfigPath: path.join(dataDir, 'mcp.json'), keys, keyDir: path.join(dataDir, 'keys') });
  if (opts.port !== undefined) sessionService.setDaemonPort(opts.port); // corrected by listening() if the daemon falls back to another port
  if (opts.structuredCommand) sessionService.setStructuredCommandOverride(opts.structuredCommand);
  const agentService = new AgentService(db, sessionService, broadcaster, path.join(dataDir, 'runs'));
  // Built ahead of rolesService so it can be handed in as RolesService's push dep — backs the
  // 2-consecutive-failed-nights auto-disable Needs-you (Task 7).
  const pushService = new PushService(db, { vapidDir: dataDir });
  const rolesService = new RolesService({ db, agentService, sessionService, pushService });
  agentService.setRoleRunner(rolesService);
  // Wakes watchers on peer status edges (see sessions/watch-dispatcher.ts).
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
  // Plugins observe hook payloads, spawns, declarations and prompts (plugins design, section 3.3).
  statusService.setHookListener((p, id, payload) => threadEvents.onHookPayload(p, id, payload));
  const harnesses = wireHarnesses({ db, sessionService, statusService, threadEvents, env, injected: opts.managers });
  const journalWiring = wireJournal(db, harnesses.managers.values()); // W3-D: the message journal
  wireRestoredQuestions(db, sessionService, harnesses.managers.values(), statusService); // a pending question survives a restart (W2-C)
  agentService.setLifecycleService(statusService);
  statusService.onHarnessCommitted((event) => { if (event.type === 'process.exited') rolesService.handleTerminalExit(event.terminalId); });

  // ── Chat (spec 2026-10-13): its own Claude manager, so its turn and compaction
  // processes never reach SessionService's thread listeners. ───────────────────
  const endlessManager: IStructuredManager = new ClaudeStructuredSessionManager();
  const ledgerService = wireLedger(db, sessionService, broadcaster);
  const endless = new EndlessService({
    ledger: ledgerService,
    db, broadcaster, manager: endlessManager,
    chatDir: path.join(dataDir, 'chat'),
    home: os.homedir(),
    limits: limitsFromEnv(env.DISPATCH_ENDLESS_LIMITS),
    openRouterKey: resolveOpenRouterKey,
    finalOutput: (id) => sessionService.finalOutput(id),
    pendingPermission: (id) => sessionService.getPendingPermission(id),
  });
  // Stage 2: a thread Chat started reports when it settles (finished or asking) or fails.
  endless.setKeyRegistry(keys);
  statusService.addThreadSettledListener(({ terminalId, threadStatus }) => endless.onThreadSettled({ terminalId, threadStatus }));
  onEndlessStatus = (terminalId, status) => endless.onThreadStatus(terminalId, status);

  // ── Sign-ins, accounts and limits ───────────────────────────────────────────
  // Terminal-free Claude login (design doc §11.2). Its token is injected by the spawn-env refresh,
  // so a box authenticated mid-session takes effect on the next spawn without a daemon restart.
  const claudeLogin = new ClaudeLoginService(dataDir);
  // A hosted box (or DISPATCH_CLAUDE_LOGIN=cli) signs in with Claude Code's own `claude auth login`:
  // no token is read, kept or injected (auth/claude-cli-login.ts). A local install keeps setup-token.
  if (useCleanClaudeLogin(env)) {
    claudeLogin.useCleanLogin(new ClaudeCliLogin({ env: () => ({ ...inheritedEnv(), ...spawnEnv.current() }) }), { ownerEmail: env.DISPATCH_OWNER_EMAIL });
    claudeLogin.onAccountConfigDir = ({ id, label, configDir, status }) => {
      accounts.upsertClaudeConfigDir({ id, label, configDir, ...(status.email ? { email: status.email } : {}), ...(planOf(status) ? { plan: planOf(status)! } : {}) });
    };
  }
  // Added Codex accounts sign in with `codex login --device-auth` under the threads' spawn env
  // (PATH with the bundled tools), so it runs the same `codex` the threads do.
  const codexLogin = new CodexLoginService({
    env: () => ({ ...inheritedEnv(), ...spawnEnv.current() }),
    isSignedIn: (home) => fs.existsSync(path.join(home, 'auth.json')),
  });
  const limits = wireLimits({
    db, env, sessionService, statusService, endless, endlessManager, claudeManager: harnesses.claude,
    accounts, claudeLogin, pushService, broadcaster, spawnEnv: () => spawnEnv.current(), network, clock: opts.clock,
  });
  const { usageLimits, limitSnapshots, usageGauge } = limits;
  // A hosted box: a chat thread whose CLI is signed out gives its process back (os/auth-stop.ts).
  const stopAuthWatch = isHostedBox(env) || useCleanClaudeLogin(env)
    ? wireStopOnAuthFailure({ managers: harnesses.managers.values(), stop: (id) => sessionService.stopTerminal(id), onAuthFailure: () => claudeLogin.noteAuthFailure() })
    : () => {};
  // Fleet totals are a read-only projection of the canonical analytics ledger.
  const usage = new UsageRecorder(db);
  wireThreadSettledPush(db, statusService, pushService);
  wirePtyUsageCapture(db, statusService, sessionService, broadcaster);
  rolesService.wireSettled(statusService);
  // Accounts per harness (multi-account spec 2026-11-06). The single saved login of earlier
  // versions becomes the account `saved`; a login started for a new account lands here, and the
  // profile call fills in its email, account id and plan.
  accounts.migrateSavedClaudeToken(claudeLogin.getToken());
  claudeLogin.onAccountToken = async (token, label, accountId) => {
    // Profile first, so signing an existing account in again updates it (adoptClaudeLoginToken).
    // With an account id ("Sign in again", W1-H) that account's token is replaced in place.
    await adoptClaudeLoginToken(accounts, token, label, fetchClaudeProfile, accountId);
  };

  // ── Secrets, integrations, tools and the spawn env ──────────────────────────
  // Doppler secrets: token-backed connection + per-spawn injection (DOPPLER_* env +
  // an MCP server) so Claude Code / Codex agents can add & retrieve secrets.
  const integrationsService = new IntegrationsService(db, integrationLauncher(dataDir), () => { const st = secretsService.status(); return st.connected && st.enabled; });
  // Tools brokered by OS, resolved per spawn (design §4.2.1).
  const osConnections = new OsConnectionsProvider();
  const toolsBase = opts.toolsDir ?? path.join(dataDir, 'tools');
  // Whether each bundled CLI can really sign in from a thread: runs its authCheck with the
  // thread spawn env (kept current by the refresh below), not this daemon's bare env.
  const toolsAuth = new ToolAuthProber({ base: toolsBase });
  const providerOfType = (type: string): AccountProvider | null => (type === 'claude-code' ? 'claude' : type === 'codex' ? 'codex' : null);
  wireSessionService(sessionService, {
    onUserPrompt: (id, text, source) => { if (source === 'user') threadAutoNamer.notifyPrompt(id, text); threadEvents.onPrompt(id, text, source); },
    onSpawned: (id, tools) => threadEvents.onSpawned(id, tools),
    onStatusDeclared: (id, decl) => threadEvents.onStatus(id, decl),
    pluginInjection: (harness, sessionId) => { const inj = plugins.modelInjection(harness); return { ...inj, prompts: [...inj.prompts, ...skills.injection(sessionId, harness)] }; },
    terminalStatusWriter: (id, status) => statusService.setTerminalState(id, status),
    onTerminalChanged: (sessionId) => broadcaster.broadcast({ type: 'session:tabs-changed', sessionId }),
    usageLimits,
    wakeWorkingMarker: (id) => statusService.markWorking(id, 'Thinking…'),
    accountEnv: (type, config) => ({ ...accounts.spawnEnv(type, config), ...secretsService.getThreadTokenEnv(config) }),
    accountDirectory: {
      has: (type, id) => { const p = providerOfType(type); return p ? accounts.has(p, id) : false; },
      defaultId: (type) => { const p = providerOfType(type); return p ? accounts.defaultId(p) : 'cli'; },
    },
    // OS's standing instruction (systemPrompt of /api/dispatch/connections) rides with the Doppler note,
    // so every harness gets it the way it gets that one (Claude --append-system-prompt, Codex
    // developerInstructions, Grok --rules, OpenCode's rules file).
    secretsServerSpec: () => ({ spec: secretsService.getServerSpec(), prompt: [secretsService.getSystemPrompt(), osConnections.getSystemPrompt()].filter(Boolean).join('\n\n') || null }),
    // The company tools (os/tools-proxy.ts): one `os-tools` server per thread when OS gives this
    // person tools, reaching OS only through this daemon's loopback route.
    integrationsSpecs: () => {
      const specs = [...integrationsService.getServerSpecs(), ...osConnections.getServerSpecs()];
      if (osConnections.osToolsUrl() && daemonApi) specs.push(osToolsServerSpec(daemonApi));
      return specs;
    },
    toolsAwareness: () => {
      // Sync, so it can only serve the cache; a stale one is refreshed behind this spawn.
      // Not without the network: the check runs each bundled CLI, and a test's tools folder can be a real one.
      if (network && toolsAuth.isStale()) void toolsAuth.refresh();
      return awarenessNote(toolStatuses({ base: toolsBase, env: toolsAuth.threadEnv(), checks: toolsAuth.snapshot().results }));
    },
  });
  const spawnEnv = wireSpawnEnv({
    db, dataDir, env, toolsBase, shimEnv: () => shimEnv, daemonApi: () => daemonApi,
    claudeLogin, osConnections, secretsService, toolsAuth, ptyManager,
    managers: () => [harnesses.claude, endlessManager, ...harnesses.extra.values()],
    opencode: () => harnesses.extra.get('opencode'),
  });
  secretsService.onChange(spawnEnv.refresh);
  // A new login reaches every spawn env first; then Chat's failed summaries run again with it.
  claudeLogin.onChange(() => { spawnEnv.refresh(); endless.retryCompaction(); });
  spawnEnv.refresh();

  // ── CLI (PTY) threads, the watchdog and the routes ──────────────────────────
  const { terminalMonitor } = wirePty({ db, ptyManager, broadcaster, agentService, statusService, authRequestService, usageLimits, threadAutoNamer });
  // Stall watchdog (W1-D): flags a working thread that sent no frame for 10 minutes
  // (DISPATCH_STALL_MINUTES). It only flags. It rides the scheduler tick (daemon/timers.ts); it has no timer.
  const stallWatchdog = createDaemonStallWatchdog({
    db, broadcaster,
    lastFrameAt: (id) => sessionService.structuredManagerForTerminal(id)?.lastFrameAt?.(id) ?? ptyManager.lastOutputAt(id),
    ...(opts.clock ? { now: opts.clock } : {}),
  });
  app.locals.stallWatchdog = stallWatchdog; // GET /api/terminals/stalls reads it
  // The "why" panel (W2-G) reads the saved notices and questions of W2-C.
  app.locals.deliveryOutbox = outbox;
  app.locals.pendingQuestions = { get: (id: string) => pendingQuestionsDb.get(db, id) };
  // Per-box state projection for the OS control plane (design §4.4.5); started by the timers.
  const boxHeartbeat = new HeartbeatService(db, () => ({
    authenticated: claudeLogin.isAuthenticated(),
    toolsReachable: osConnections.snapshot().reachable,
    usage7d: usage.total(7),
    usageByModel7d: usage.byModel(7),
  }));

  bootAnalytics(db);
  // The one list of /api routes.
  mountApiRoutes(app, {
    db, sessionService, statusService, agentService, rolesService, authRequestService,
    claudeLogin, codexLogin, accounts, assistAccounts: opts.assistAccounts, secretsService, integrationsService, pushService, ledgerService,
    toolsBase, toolsAuth, dataDir, repoRoot: resolveRepoRoot(),
    broadcaster, plugins, assistRunner, terminalsBroadcaster: broadcaster,
    noCredentialStats: auth.noCredentialStats, pairCodes: auth.pairCodes, devices: auth.devices, cookiePath: basePath || '/',
    reachableAddresses: auth.reachableAddresses, refreshPtyEnv: spawnEnv.refresh,
    endless: opts.endless ?? endless, usageLimits: opts.usageLimits ?? limits.routeDeps,
    watchCatchUp: (id) => watchDispatcher.catchUp(id), outbox, journal: journalWiring.journal,
  });
  // Company tools (os/tools-proxy.ts): the loopback route a thread's os-tools bridge calls, and the
  // state the Company connections panel reads. On a local install OS is not configured, so the routes
  // answer "not hosted" and inject nothing.
  app.use('/api', createOsToolsRouter({
    provider: osConnections,
    onUnreachable: (terminalId, message) => {
      sessionService.structuredManagerForTerminal(terminalId)?.postEvent?.(terminalId, { type: 'system', subtype: 'dispatch_notice', level: 'warning', message });
    },
  }));
  // Any change from OS (the boot fetch included) reaches the spawn env at once: the short-lived tokens
  // of OS's own servers live in `env`, and before this they arrived only with some later refresh.
  app.use('/api', createApprovalsRouter(db, sessionService));
  // The profile a spawn reads now: OS's answer (authoritative, live), else DISPATCH_PROFILE.
  setProfileSource(() => osConnections.snapshot().profile ?? envProfile(env));
  osConnections.onChange(() => {
    spawnEnv.refresh();
    broadcaster.broadcast({ type: 'os:connections', state: osConnections.publicSnapshot() });
  });
  const webDist = opts.webDist === undefined ? defaultWebDist(env) : opts.webDist;
  const servesWeb = mountWeb(app, { webDist, basePath, dataDir, plugins });
  // Last: every error that no route answered becomes a JSON status and message, never a stack trace.
  app.use(jsonErrorHandler);

  const services: DaemonServices = {
    db, dataDir, keys, noCredentialStats: auth.noCredentialStats, accessGate: auth.accessGate, pairCodes: auth.pairCodes, devices: auth.devices,
    authRequestService, claudeLogin, codexLogin, accounts, sockets, broadcaster, ptyManager, sessionService, statusService,
    harnessManagers: harnesses.managers, structuredManager: harnesses.claude, terminalMonitor, threadAutoNamer, stallWatchdog,
    agentService, rolesService, outbox, watchDispatcher, ledgerService, pushService, endless, endlessManager,
    usageLimits, limitSnapshots, usageGauge, usage, boxHeartbeat, secretsService, integrationsService, osConnections, toolsAuth,
    refreshSpawnEnv: spawnEnv.refresh, plugins, marketplaces, installer, skills, threadEvents, pluginHooks, pluginWorkers, assistRunner,
  };

  // ── The life of the daemon ──────────────────────────────────────────────────
  const servers: http.Server[] = [];
  let stopTimers: (() => void) | null = null;
  let stopped = false;
  const onUpgrade = createUpgradeHandler({
    sockets, basePath, boxToken: auth.boxToken, accessGate: auth.accessGate, devices: auth.devices,
    sessionService, statusService, ptyManager, terminalMonitor, claudeManager: harnesses.claude,
  });
  return {
    app, services, basePath, webDist: servesWeb ? webDist : null,
    attach(server) {
      server.on('upgrade', onUpgrade);
      servers.push(server);
    },
    listening(port, update) {
      const api = `http://127.0.0.1:${port}${basePath}`;
      sessionService.setDaemonPort(port);
      sessionService.setDaemonApi(api);
      if (api !== daemonApi || update?.shimEnv) {
        daemonApi = api;
        if (update?.shimEnv) shimEnv = update.shimEnv;
        spawnEnv.refresh();
      }
      // Workers (plugins design, section 4): start the worker of each enabled plugin, now that its address is known.
      pluginWorkers.sync();
      // Store port in app state
      appState.set(db, 'port', String(port));
      // Endless Chat needs the real port for its memory MCP server config. A failed start
      // logs and disables only the chat (its routes answer 503); the daemon keeps running.
      startEndless(endless, port);
      // Status hooks: tell SessionService how to make spawned agents phone home with
      // lifecycle events (Claude hooks settings file + Codex notify helper).
      const here = path.dirname(fileURLToPath(import.meta.url));
      sessionService.setStatusContext({
        serverUrl: api,
        hooksDir: path.join(dataDir, 'hooks'),
        codexHelperPath: path.resolve(here, '../../scripts/codex-notify.mjs'),
        grokHelperPath: path.resolve(here, '../../scripts/grok-hook.mjs'),
      });
    },
    startTimers() {
      if (stopTimers) return stopTimers;
      if (!timersOn || stopped) return () => {};
      return stopTimers = startDaemonTimers(daemonTimers(services, { network }));
    },
    bootRecover: (o) => runBootRecovery(services, { network, settleMs: o?.settleMs }),
    stop() {
      if (stopped) return;
      stopped = true;
      sessionService.revokeEveryKey(); // the sticky Codex Pretty keys end with the daemon
      stopTimers?.();
      plugins.stop();
      pluginHooks.stop();
      void pluginWorkers.stop();
      usageLimits.stop();
      usageGauge.stop();
      boxHeartbeat.stop();
      osConnections.stop();
      stopAuthWatch();
      threadAutoNamer.dispose();
      endless.stop();
      endlessManager.killAll();
      ptyManager.killAll();
      // Each manager kill settles its thread to `waiting` synchronously; keep the mid-turn overseer
      // threads `working` so the next boot's kickstart resumes them.
      sessionService.shutdownPreservingInterruptedTurns(() => {
        harnesses.claude.killAll();
        for (const manager of harnesses.extra.values()) manager.killAll();
      });
      // WebSocketServer.close() stops upgrades but leaves connected browsers alive.
      // Those upgraded sockets keep Node running forever, so WSL's updater times out
      // waiting for this process to exit. Disconnect them explicitly before closing.
      for (const wss of sockets.all) {
        for (const client of wss.clients) client.terminate();
        wss.close();
      }
      for (const server of servers) {
        server.close();
        server.closeAllConnections();
      }
    },
  };
}
