import type { Express, Request, Response, Router } from 'express';
import type Database from 'better-sqlite3';
import type { SessionService } from './sessions/service.js';
import type { StatusService } from './status/service.js';
import type { AgentService } from './agents/service.js';
import type { RolesService } from './roles/service.js';
import type { AuthRequestService } from './auth/service.js';
import fs from 'fs';
import path from 'path';
import type { ClaudeLoginService } from './auth/claude-login.js';
import { CodexLoginService } from './auth/codex-login.js';
import { createThreadSecretsRouter } from './routes/thread-secrets.js';
import { createInboxSecretsRouter } from './routes/inbox-secrets.js';
import type { SecretsService } from './secrets/service.js';
import type { IntegrationsService } from './integrations/service.js';
import type { PushService } from './push/service.js';
import type { LedgerService } from './overseer/ledger-service.js';
import type { EndlessService } from './endless/service.js';
import type { LimitSnapshots } from './limits/snapshot.js';
import type { UsageSummary } from './limits/gauge.js';
import type { CodexRefresh } from './limits/codex-refresh.js';
import type { ToolAuthProber } from './tools/auth-probe.js';
import type { EventBroadcaster } from './ws/events.js';
import type { NoCredentialStats } from './auth/no-credential-stats.js';
import type { PairCodes } from './auth/pair-code.js';
import type { DeviceStore } from './auth/devices.js';
import type { Reachable } from './auth/reachable-addresses.js';
import { COOKIE_NAME } from './auth/access-token.js';
import { principalOf } from './auth/request-principal.js';
import { noCredentialStatsHandler, whoamiHandler } from './auth/request-principal.js';
import { ownerOnly, ownerOnlyStrict, policyRouter, publicRoute } from './auth/route-policy.js';
import { mountRouter } from './http/route-registry.js';
import { TranscriptionService } from './transcription/service.js';
import { createSessionsRouter } from './routes/sessions.js';
import { createTerminalsRouter } from './routes/terminals.js';
import { createLedgerRouter } from './routes/ledger.js';
import { createPluginsRouter } from './routes/plugins.js';
import { createInboxRouter } from './routes/inbox.js';
import { defaultSecretRoots } from './files/secret-paths.js';
import type { PluginRegistry } from './plugins/registry.js';
import type { AssistRunner } from './assist/run.js';
import { createEventsRouter } from './routes/events.js';
import { createAgentsRouter } from './routes/agents.js';
import { createRolesRouter } from './routes/roles.js';
import { createProvidersRouter } from './routes/providers.js';
import { createServersRouter } from './routes/servers.js';
import { createSecretsRouter } from './routes/secrets.js';
import { createHarnessSettingsRouter } from './routes/harness-settings.js';
import { createTelemetrySettingsRouter } from './routes/telemetry-settings.js';
import { createDictationSettingsRouter, createCoordinatorSettingsRouter } from './routes/shared-settings.js';
import { createUsageLimitSettingsRouter } from './routes/usage-limit-settings.js';
import { createTranscribeRouter } from './routes/transcribe.js';
import { createSetupRouter } from './routes/setup.js';
import { createFilesRouter } from './routes/files.js';
import { createGitRouter, createWorktreesRouter } from './routes/git.js';
import { createAuthRouter } from './routes/auth.js';
import { createClaudeAuthRouter } from './routes/claude-auth.js';
import { createAccountsRouter } from './routes/accounts.js';
import type { AccountsStore, AccountProvider } from './auth/accounts.js';
import * as terminalsDb from './db/terminals.js';
import { ThreadConfigStore } from './sessions/thread-config.js';
import { readClaudeToken, fetchClaudeProfile } from './limits/claude-usage.js';
import { createStateRouter } from './routes/state.js';
import { createIntegrationsRouter } from './routes/integrations.js';
import { createPushRouter } from './routes/push.js';
import { createToolsRouter } from './routes/tools.js';
import { createUpdateRouter } from './routes/update.js';
import { createAppearanceRouter } from './routes/appearance.js';
import { createWatchesRouter } from './routes/watches.js';
import { createOutboxRouter } from './routes/outbox.js';
import { createJournalRouter } from './routes/journal.js';
import { createSubagentsRouter } from './routes/subagents.js';
import { createAnalyticsRouter } from './routes/analytics.js';
import { createEndlessRouter } from './routes/endless.js';
import { createUsageLimitsRouter } from './routes/usage-limits.js';
import { createBootstrapRouter } from './routes/bootstrap.js';
import { hostContextResponse, type HostContext } from './profile/host-context.js';
import { createChatsRouter } from './routes/chats.js';

/** Everything the `/api` routes need. `createApp` (tests) and `startServer` (daemon) both build one. */
export interface ApiRouteDeps {
  db: Database.Database;
  sessionService: SessionService;
  statusService: StatusService;
  agentService: AgentService;
  rolesService: RolesService;
  authRequestService: AuthRequestService;
  claudeLogin: ClaudeLoginService;
  /** The device-code sign-in for added Codex accounts. Absent: one is built on the daemon's own env. */
  codexLogin?: CodexLoginService;
  /** Accounts per harness (multi-account spec). Absent in a bare createApp: the routes are not mounted. */
  accounts?: AccountsStore;
  /** The accounts the plugin assist route knows (test seam); defaults to `accounts`. */
  assistAccounts?: Pick<AccountsStore, 'has' | 'defaultId'>;
  secretsService: SecretsService;
  integrationsService: IntegrationsService;
  pushService: PushService;
  ledgerService: LedgerService;
  toolsBase: string;
  toolsAuth: ToolAuthProber;
  /** The data directory (appearance files). */
  dataDir: string;
  repoRoot: string;
  /** For the sessions router. */
  broadcaster: EventBroadcaster;
  /** Plugins (docs/superpowers/specs/2026-11-07-plugins-design.md). */
  plugins: PluginRegistry;
  /** Model assist for plugins (spec section 3.4); null when no model is configured. */
  assistRunner?: AssistRunner | null;
  /** For the terminals router. `createApp` leaves it unset, as it always has. */
  terminalsBroadcaster?: EventBroadcaster;
  noCredentialStats: NoCredentialStats;
  /** One-time sign-in codes (Settings → Devices & access). Absent in `createApp` and on a hosted box, where
   *  there is no sign-in page to type one on: `POST /api/access/pair-code` then answers 404. */
  pairCodes?: PairCodes;
  /** Signed-in devices (Settings → Devices & access). Absent in `createApp` and on a hosted box: the device routes then answer 404. */
  devices?: DeviceStore;
  /** Addresses a phone could use to reach this computer (Settings > Devices & access). Absent in `createApp`: the route then answers empty lists. */
  reachableAddresses?: () => Promise<Reachable>;
  /** Cookie Path, for clearing a device's own cookie when it revokes itself. */
  cookiePath?: string;
  /** Re-reads the spawn env after a secrets or harness-settings write (daemon only). */
  refreshPtyEnv?: () => void;
  /** Absent in `createApp` unless a test passes a stub: `/api/endless` then answers 503. */
  endless?: EndlessService;
  /** Daemon only: the account limit figures behind `/api/usage-limits`. `createApp` leaves it unset, as main does. */
  /** Catches a watch up with a target that already settled; absent in tests that do not need it. */
  watchCatchUp?: (watchId: string) => string | null;
  /** The delivery outbox (W2-C): GET /api/outbox lists its rows. */
  outbox?: import('./delivery/outbox.js').DeliveryOutbox;
  /**
   * The hosted-box routers (os/*: company tools, approvals, continuity), each mounted at /api. Built in
   * daemon/build.ts from services this file does not know; absent in a bare createApp.
   */
  osRouters?: import('express').Router[];
  /** The message journal (W3-D): GET /api/terminals/:terminalId/journal reads its pages. */
  journal?: import('./journal/journal.js').MessageJournal;
  /**
   * The profile and host facts NOW (profile/host-context.ts `liveHostContext`), read per request so a
   * profile change from OS applies without a restart. Absent (a bare createApp): developer, not hosted.
   */
  hostContext?: HostContext | (() => HostContext);
  usageLimits?: {
    /** The Refresh button of the usage window (2026-11-09): read every account now. */
    refresh?: () => Promise<void>;
    snapshots: LimitSnapshots;
    accountFor: (provider: string) => string;
    /** The gauge's summary and the shared Codex refresher (#127). */
    summary?: () => UsageSummary;
    refreshCodex?: CodexRefresh;
    /** Applies a settings PUT live: the gauge rebroadcasts with the new threshold. */
    onSettingsChange?: () => void;
    /** Spend a banked limit reset (Codex). */
    useResetCredit?: (provider: string, creditId?: string, accountId?: string) => Promise<string | null>;
  };
}

/**
 * The one list of `/api` mounts. Order matters: `/api/sessions` before `/api/sessions/:id/files`,
 * and the `/api` terminals and ledger routers before the rest, exactly as before.
 */
export function mountApiRoutes(app: Express, deps: ApiRouteDeps): void {
  const d = deps;
  const given = d.hostContext ?? { profile: 'developer', hosted: false, osBaseUrl: null, ownerEmail: null };
  const hostContext = (): HostContext => (typeof given === 'function' ? given() : given);
  // Every router goes through `mount`, so the route registry knows its mount path (http/route-registry.ts):
  // the profile table (profile/business-routes.ts) is keyed by the registered pattern of each route.
  const mount = (prefix: string, router: Router): void => mountRouter(app, prefix, router);
  // The routes that belong to no router of their own. A policyRouter like every other: each route starts
  // with the profile guard.
  const top = policyRouter();
  top.get('/api/whoami', publicRoute, whoamiHandler);
  // What the page needs at launch to choose its profile, theme and way back to OS. No secrets.
  top.get('/api/host-context', ownerOnly, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    // `capabilities`: what this build enforces. OS reads it at provisioning (box contract 2026-11-11).
    res.json(hostContextResponse(hostContext()));
  });
  top.get('/api/access/no-credential-stats', ownerOnly, noCredentialStatsHandler(d.noCredentialStats));
  // The owner (a signed-in or local browser) makes a code; a thread key gets owner_only. The code
  // is the only secret that leaves the daemon: the token itself is never served. Strict (W1-B): a code signs a
  // device in as the owner, so a local call with no credential must look like the web page.
  top.post('/api/access/pair-code', ownerOnlyStrict, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!d.pairCodes) return void res.status(404).json({ error: 'not_available' });
    res.json(d.pairCodes.issue());
  });

  mountDeviceRoutes(top, d);

  // Owner only: the lists name this computer's network addresses. A browser on this computer only knows `localhost`.
  top.get('/api/access/addresses', ownerOnly, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    (d.reachableAddresses?.() ?? Promise.resolve({ tailscale: [], lan: [] }))
      .then((r) => res.json(r))
      .catch(() => res.json({ tailscale: [], lan: [] }));
  });

  mount('', top);
  for (const r of d.osRouters ?? []) mount('/api', r);
  mount('/api', createChatsRouter(d.db)); // docs/headless-api.md
  mount('/api/sessions', createSessionsRouter(d.sessionService, d.broadcaster, d.db));
  mount('/api', createTerminalsRouter(d.sessionService, d.terminalsBroadcaster, d.statusService));
  if (d.journal) mount('/api', createJournalRouter(d.journal, (id) => !!d.sessionService.getTerminal(id))); // W3-D
  // subagents-v1: the subagents of a thread (list, one subagent's journal, stop).
  mount('/api', createSubagentsRouter({
    journal: d.journal,
    thread: (id) => d.sessionService.getTerminal(id),
    manager: (id) => d.sessionService.structuredManagerForTerminal(id),
  }));
  mount('/api', createThreadSecretsRouter(d.db, { broadcast: (e) => d.terminalsBroadcaster?.broadcast(e) }));
  mount('/api', createLedgerRouter(d.ledgerService));
  // Inbox → Send a secret (2026-11-12): the owner's secrets for a thread, by a short ID. Under the Inbox plugin's path
  // (/api/plugins/previews/secrets), mounted before the plugins router.
  mount('/api', createInboxSecretsRouter(d.db, {
    dataDir: d.dataDir, secrets: d.secretsService, secretRoots: defaultSecretRoots(d.dataDir),
    broadcast: (e) => d.broadcaster.broadcast(e),
  }));
  const accountsForAssist = d.assistAccounts ?? d.accounts;
  mount('/api', createPluginsRouter(d.plugins, d.db, d.assistRunner ?? null, {
    summary: d.usageLimits?.summary,
    defaultAccount: accountsForAssist ? (h) => accountsForAssist.defaultId(h) : undefined,
    hasAccount: accountsForAssist ? (h, id) => accountsForAssist.has(h, id) : undefined,
    push: d.pushService,
    secretRoots: defaultSecretRoots(d.dataDir),
    dataDir: d.dataDir,
  }));
  // The Inbox for a view outside this web client (docs/headless-api.md section 11).
  mount('/api', createInboxRouter(d.db, { broadcast: (e) => d.plugins.broadcast(e), secretRoots: defaultSecretRoots(d.dataDir), dataDir: d.dataDir }));
  mount('/api/events', createEventsRouter(d.statusService));
  mount('/api/agents', createAgentsRouter(d.agentService));
  mount('/api/roles', createRolesRouter(d.rolesService));
  mount('/api/providers', createProvidersRouter());
  mount('/api/servers', createServersRouter(d.db));
  mount('/api/secrets', createSecretsRouter(d.secretsService, d.refreshPtyEnv));
  mount('/api/settings/harnesses', createHarnessSettingsRouter(d.db, d.secretsService, d.refreshPtyEnv));
  mount('/api/settings/telemetry', createTelemetrySettingsRouter(d.db));
  mount('/api/settings/dictation', createDictationSettingsRouter(d.db));
  mount('/api/settings/coordinator', createCoordinatorSettingsRouter(d.db));
  mount('/api/settings/usage-limits', createUsageLimitSettingsRouter(d.db, { onChange: () => d.usageLimits?.onSettingsChange?.() }));
  mount('/api/transcribe', createTranscribeRouter(new TranscriptionService(d.secretsService)));
  mount('/api/setup', createSetupRouter(d.db, d.secretsService));
  mount('/api/sessions/:id/files', createFilesRouter(d.db));
  mount('/api/sessions/:id/git', createGitRouter(d.db));
  mount('/api/sessions/:id/worktrees', createWorktreesRouter(d.db)); // W3-G
  mount('/api/auth-requests', createAuthRouter(d.authRequestService));
  mount('/api/claude-auth', createClaudeAuthRouter(d.claudeLogin));
  if (d.accounts) {
    const accounts = d.accounts;
    const typeOf = (provider: AccountProvider) => (provider === 'claude' ? 'claude-code' : 'codex');
    mount('/api/accounts', createAccountsRouter(accounts, d.claudeLogin, {
      // The CLI login's profile comes from its own token (keychain or credentials file) and is
      // only shown; an added account's is written back so the next list needs no call.
      claudeProfile: async (accountId) => {
        // The clean login (hosted): `claude auth status` in the account's own config dir; no token is read.
        if (d.claudeLogin.usesCleanLogin) {
          const st = await d.claudeLogin.cliStatus({ configDir: accountId === 'cli' ? null : accounts.claudeConfigDir(accountId) });
          if (!st?.loggedIn) return null;
          const p = { ...(st.email ? { email: st.email } : {}), ...(st.planTier || st.subscriptionType ? { plan: st.planTier || st.subscriptionType } : {}) };
          if (accountId !== 'cli') accounts.updateClaude(accountId, p);
          return p;
        }
        const token = accountId === 'cli' ? await readClaudeToken({}) : accounts.claudeToken(accountId);
        if (!token) return null;
        const p = await fetchClaudeProfile(token);
        if (p && accountId !== 'cli') accounts.updateClaude(accountId, p);
        return p;
      },
      threads: {
        pinnedTo: (provider, accountId) => terminalsDb.listPinnedToAccount(d.db, typeOf(provider), accountId).map((t) => ({ id: t.id, label: t.label, sessionId: t.session_id })),
        unpin: (provider, accountId) => {
          const rows = terminalsDb.listPinnedToAccount(d.db, typeOf(provider), accountId);
          const store = new ThreadConfigStore(d.db);
          for (const t of rows) store.patch(t.id, { accountId: null });
          return rows.length;
        },
      },
      codexLogin: d.codexLogin ?? new CodexLoginService({ env: () => process.env, isSignedIn: (home) => fs.existsSync(path.join(home, 'auth.json')) }),
    }));
  }
  mount('/api/state', createStateRouter(d.db));
  mount('/api/integrations', createIntegrationsRouter(d.integrationsService));
  mount('/api/push', createPushRouter(d.pushService));
  mount('/api/tools', createToolsRouter({ base: d.toolsBase, prober: d.toolsAuth }));
  mount('/api/update', createUpdateRouter(d.broadcaster, d.repoRoot, d.db));
  mount('/api/appearance', createAppearanceRouter(d.dataDir));
  mount('/api/watches', createWatchesRouter(d.db, d.watchCatchUp));
  if (d.outbox) mount('/api/outbox', createOutboxRouter(d.outbox));
  mount('/api/analytics', createAnalyticsRouter(d.db));
  if (d.usageLimits) mount('/api', createUsageLimitsRouter(d.db, d.usageLimits.snapshots, { accountFor: d.usageLimits.accountFor, refreshCodex: d.usageLimits.refreshCodex, summary: d.usageLimits.summary, refresh: d.usageLimits.refresh, useResetCredit: d.usageLimits.useResetCredit }));
  if (d.endless) mount('/api/endless', createEndlessRouter(d.endless));
  else app.use('/api/endless', ownerOnly, (_req, res) => { res.status(503).json({ error: 'Chat is unavailable' }); });
  mount('/api/bootstrap', createBootstrapRouter(app)); // W2-H: the launch calls in one answer, each part read through its own route
}

/**
 * Signed-in devices (network exposure spec 8.1/8.2). Owner only: a thread key gets 403 from
 * `ownerOnly` before any handler runs. A device cookie is the owner's, so a signed-in phone can
 * list and revoke the others, and itself.
 */
function mountDeviceRoutes(app: Router, d: ApiRouteDeps): void {
  const devices = d.devices;
  const currentDevice = (req: Request): string | null => {
    const p = principalOf(req);
    return p.kind === 'owner' && p.deviceId ? p.deviceId : null;
  };
  const unavailable = (res: Response) => void res.status(404).json({ error: 'not_available' });

  app.get('/api/access/devices', ownerOnly, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!devices) return unavailable(res);
    const current = currentDevice(req);
    res.json({
      devices: devices.list().map((x) => ({ ...x, current: x.id === current })),
      currentDeviceId: current,
      legacyOpen: devices.legacyAllowed(),
    });
  });

  app.patch('/api/access/devices/:id', ownerOnly, (req, res) => {
    if (!devices) return unavailable(res);
    const name = (req.body as { name?: unknown } | undefined)?.name;
    if (typeof name !== 'string' || !name.trim()) return void res.status(400).json({ error: 'bad_name' });
    if (!devices.rename(String(req.params.id), name)) return void res.status(404).json({ error: 'no_such_device' });
    res.json({ ok: true });
  });

  app.delete('/api/access/devices/:id', ownerOnly, (req, res) => {
    if (!devices) return unavailable(res);
    const id = String(req.params.id);
    const self = currentDevice(req) === id;
    if (!devices.revoke(id)) return void res.status(404).json({ error: 'no_such_device' });
    // Signing out this very browser: drop its cookie too, so the page lands on the sign-in page.
    if (self) res.append('Set-Cookie', `${COOKIE_NAME}=; Path=${d.cookiePath || '/'}; Max-Age=0; HttpOnly; SameSite=Lax`);
    res.json({ ok: true });
  });

  // Turns off the shared cookie that every browser held before the device list. A browser that
  // has not opened Dispatch since the update has to sign in again.
  app.post('/api/access/devices/end-legacy', ownerOnly, (_req, res) => {
    if (!devices) return unavailable(res);
    devices.endLegacy();
    res.json({ ok: true });
  });
}
