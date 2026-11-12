import type { Express, Request, Response } from 'express';
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
import { ownerOnly, ownerOnlyStrict, publicRoute } from './auth/route-policy.js';
import { TranscriptionService } from './transcription/service.js';
import { createSessionsRouter } from './routes/sessions.js';
import { createTerminalsRouter } from './routes/terminals.js';
import { createLedgerRouter } from './routes/ledger.js';
import { createPluginsRouter } from './routes/plugins.js';
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
import { createAnalyticsRouter } from './routes/analytics.js';
import { createEndlessRouter } from './routes/endless.js';
import { createUsageLimitsRouter } from './routes/usage-limits.js';
import { createBootstrapRouter } from './routes/bootstrap.js';

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
  /** The message journal (W3-D): GET /api/terminals/:terminalId/journal reads its pages. */
  journal?: import('./journal/journal.js').MessageJournal;
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
  app.get('/api/whoami', publicRoute, whoamiHandler);
  app.get('/api/access/no-credential-stats', ownerOnly, noCredentialStatsHandler(d.noCredentialStats));
  // The owner (a signed-in or local browser) makes a code; a thread key gets owner_only. The code
  // is the only secret that leaves the daemon: the token itself is never served. Strict (W1-B): a code signs a
  // device in as the owner, so a local call with no credential must look like the web page.
  app.post('/api/access/pair-code', ownerOnlyStrict, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!d.pairCodes) return void res.status(404).json({ error: 'not_available' });
    res.json(d.pairCodes.issue());
  });

  mountDeviceRoutes(app, d);

  // Owner only: the lists name this computer's network addresses. A browser on this computer only knows `localhost`.
  app.get('/api/access/addresses', ownerOnly, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    (d.reachableAddresses?.() ?? Promise.resolve({ tailscale: [], lan: [] }))
      .then((r) => res.json(r))
      .catch(() => res.json({ tailscale: [], lan: [] }));
  });

  app.use('/api/sessions', createSessionsRouter(d.sessionService, d.broadcaster, d.db));
  app.use('/api', createTerminalsRouter(d.sessionService, d.terminalsBroadcaster, d.statusService));
  if (d.journal) app.use('/api', createJournalRouter(d.journal, (id) => !!d.sessionService.getTerminal(id))); // W3-D
  app.use('/api', createThreadSecretsRouter(d.db, { broadcast: (e) => d.terminalsBroadcaster?.broadcast(e) }));
  app.use('/api', createLedgerRouter(d.ledgerService));
  const accountsForAssist = d.assistAccounts ?? d.accounts;
  app.use('/api', createPluginsRouter(d.plugins, d.db, d.assistRunner ?? null, {
    summary: d.usageLimits?.summary,
    defaultAccount: accountsForAssist ? (h) => accountsForAssist.defaultId(h) : undefined,
    hasAccount: accountsForAssist ? (h, id) => accountsForAssist.has(h, id) : undefined,
    push: d.pushService,
    secretRoots: defaultSecretRoots(d.dataDir),
    dataDir: d.dataDir,
  }));
  // Inbox → Send a secret (2026-11-12): the owner's secrets for a thread, by a short ID.
  app.use('/api', createInboxSecretsRouter(d.db, {
    dataDir: d.dataDir, secrets: d.secretsService, secretRoots: defaultSecretRoots(d.dataDir),
    broadcast: (e) => d.broadcaster.broadcast(e),
  }));
  app.use('/api/events', createEventsRouter(d.statusService));
  app.use('/api/agents', createAgentsRouter(d.agentService));
  app.use('/api/roles', createRolesRouter(d.rolesService));
  app.use('/api/providers', createProvidersRouter());
  app.use('/api/servers', createServersRouter(d.db));
  app.use('/api/secrets', createSecretsRouter(d.secretsService, d.refreshPtyEnv));
  app.use('/api/settings/harnesses', createHarnessSettingsRouter(d.db, d.secretsService, d.refreshPtyEnv));
  app.use('/api/settings/telemetry', createTelemetrySettingsRouter(d.db));
  app.use('/api/settings/dictation', createDictationSettingsRouter(d.db));
  app.use('/api/settings/coordinator', createCoordinatorSettingsRouter(d.db));
  app.use('/api/settings/usage-limits', createUsageLimitSettingsRouter(d.db, { onChange: () => d.usageLimits?.onSettingsChange?.() }));
  app.use('/api/transcribe', createTranscribeRouter(new TranscriptionService(d.secretsService)));
  app.use('/api/setup', createSetupRouter(d.db, d.secretsService));
  app.use('/api/sessions/:id/files', createFilesRouter(d.db));
  app.use('/api/sessions/:id/git', createGitRouter(d.db));
  app.use('/api/sessions/:id/worktrees', createWorktreesRouter(d.db)); // W3-G
  app.use('/api/auth-requests', createAuthRouter(d.authRequestService));
  app.use('/api/claude-auth', createClaudeAuthRouter(d.claudeLogin));
  if (d.accounts) {
    const accounts = d.accounts;
    const typeOf = (provider: AccountProvider) => (provider === 'claude' ? 'claude-code' : 'codex');
    app.use('/api/accounts', createAccountsRouter(accounts, d.claudeLogin, {
      // The CLI login's profile comes from its own token (keychain or credentials file) and is
      // only shown; an added account's is written back so the next list needs no call.
      claudeProfile: async (accountId) => {
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
  app.use('/api/state', createStateRouter(d.db));
  app.use('/api/integrations', createIntegrationsRouter(d.integrationsService));
  app.use('/api/push', createPushRouter(d.pushService));
  app.use('/api/tools', createToolsRouter({ base: d.toolsBase, prober: d.toolsAuth }));
  app.use('/api/update', createUpdateRouter(d.broadcaster, d.repoRoot, d.db));
  app.use('/api/appearance', createAppearanceRouter(d.dataDir));
  app.use('/api/watches', createWatchesRouter(d.db, d.watchCatchUp));
  if (d.outbox) app.use('/api/outbox', createOutboxRouter(d.outbox));
  app.use('/api/analytics', createAnalyticsRouter(d.db));
  if (d.usageLimits) app.use('/api', createUsageLimitsRouter(d.db, d.usageLimits.snapshots, { accountFor: d.usageLimits.accountFor, refreshCodex: d.usageLimits.refreshCodex, summary: d.usageLimits.summary, refresh: d.usageLimits.refresh, useResetCredit: d.usageLimits.useResetCredit }));
  if (d.endless) app.use('/api/endless', createEndlessRouter(d.endless));
  else app.use('/api/endless', ownerOnly, (_req, res) => { res.status(503).json({ error: 'Chat is unavailable' }); });
  app.use('/api/bootstrap', createBootstrapRouter(app)); // W2-H: the launch calls in one answer, each part read through its own route
}

/**
 * Signed-in devices (network exposure spec 8.1/8.2). Owner only: a thread key gets 403 from
 * `ownerOnly` before any handler runs. A device cookie is the owner's, so a signed-in phone can
 * list and revoke the others, and itself.
 */
function mountDeviceRoutes(app: Express, d: ApiRouteDeps): void {
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
