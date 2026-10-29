import type { Express } from 'express';
import type Database from 'better-sqlite3';
import type { SessionService } from './sessions/service.js';
import type { StatusService } from './status/service.js';
import type { AgentService } from './agents/service.js';
import type { RolesService } from './roles/service.js';
import type { AuthRequestService } from './auth/service.js';
import type { ClaudeLoginService } from './auth/claude-login.js';
import type { SecretsService } from './secrets/service.js';
import type { IntegrationsService } from './integrations/service.js';
import type { PushService } from './push/service.js';
import type { LedgerService } from './overseer/ledger-service.js';
import type { EndlessService } from './endless/service.js';
import type { LimitSnapshots } from './limits/snapshot.js';
import type { ToolAuthProber } from './tools/auth-probe.js';
import type { EventBroadcaster } from './ws/events.js';
import type { NoCredentialStats } from './auth/no-credential-stats.js';
import type { PairCodes } from './auth/pair-code.js';
import { noCredentialStatsHandler, whoamiHandler } from './auth/request-principal.js';
import { ownerOnly, publicRoute } from './auth/route-policy.js';
import { TranscriptionService } from './transcription/service.js';
import { createSessionsRouter } from './routes/sessions.js';
import { createTerminalsRouter } from './routes/terminals.js';
import { createLedgerRouter } from './routes/ledger.js';
import { createPreviewsRouter } from './routes/previews.js';
import { createEventsRouter } from './routes/events.js';
import { createAgentsRouter } from './routes/agents.js';
import { createRolesRouter } from './routes/roles.js';
import { createProvidersRouter } from './routes/providers.js';
import { createServersRouter } from './routes/servers.js';
import { createSecretsRouter } from './routes/secrets.js';
import { createHarnessSettingsRouter } from './routes/harness-settings.js';
import { createTelemetrySettingsRouter } from './routes/telemetry-settings.js';
import { createTranscribeRouter } from './routes/transcribe.js';
import { createSetupRouter } from './routes/setup.js';
import { createFilesRouter } from './routes/files.js';
import { createGitRouter } from './routes/git.js';
import { createAuthRouter } from './routes/auth.js';
import { createClaudeAuthRouter } from './routes/claude-auth.js';
import { createStateRouter } from './routes/state.js';
import { createIntegrationsRouter } from './routes/integrations.js';
import { createPushRouter } from './routes/push.js';
import { createToolsRouter } from './routes/tools.js';
import { createUpdateRouter } from './routes/update.js';
import { createAppearanceRouter } from './routes/appearance.js';
import { createWatchesRouter } from './routes/watches.js';
import { createAnalyticsRouter } from './routes/analytics.js';
import { createEndlessRouter } from './routes/endless.js';
import { createUsageLimitsRouter } from './routes/usage-limits.js';

/** Everything the `/api` routes need. `createApp` (tests) and `startServer` (daemon) both build one. */
export interface ApiRouteDeps {
  db: Database.Database;
  sessionService: SessionService;
  statusService: StatusService;
  agentService: AgentService;
  rolesService: RolesService;
  authRequestService: AuthRequestService;
  claudeLogin: ClaudeLoginService;
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
  /** For the terminals router. `createApp` leaves it unset, as it always has. */
  terminalsBroadcaster?: EventBroadcaster;
  noCredentialStats: NoCredentialStats;
  /** One-time sign-in codes (Settings → Access). Absent in `createApp` and on a hosted box, where
   *  there is no sign-in page to type one on: `POST /api/access/pair-code` then answers 404. */
  pairCodes?: PairCodes;
  /** Re-reads the spawn env after a secrets or harness-settings write (daemon only). */
  refreshPtyEnv?: () => void;
  /** Absent in `createApp` unless a test passes a stub: `/api/endless` then answers 503. */
  endless?: EndlessService;
  /** Daemon only: the account limit figures behind `/api/usage-limits`. `createApp` leaves it unset, as main does. */
  /** Catches a watch up with a target that already settled; absent in tests that do not need it. */
  watchCatchUp?: (watchId: string) => string | null;
  usageLimits?: { snapshots: LimitSnapshots; accountFor: (provider: string) => string };
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
  // is the only secret that leaves the daemon: the token itself is never served.
  app.post('/api/access/pair-code', ownerOnly, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!d.pairCodes) return void res.status(404).json({ error: 'not_available' });
    res.json(d.pairCodes.issue());
  });

  app.use('/api/sessions', createSessionsRouter(d.sessionService, d.broadcaster, d.db));
  app.use('/api', createTerminalsRouter(d.sessionService, d.terminalsBroadcaster, d.statusService));
  app.use('/api', createLedgerRouter(d.ledgerService));
  app.use('/api', createPreviewsRouter(d.db, d.broadcaster));
  app.use('/api/events', createEventsRouter(d.statusService));
  app.use('/api/agents', createAgentsRouter(d.agentService));
  app.use('/api/roles', createRolesRouter(d.rolesService));
  app.use('/api/providers', createProvidersRouter());
  app.use('/api/servers', createServersRouter(d.db));
  app.use('/api/secrets', createSecretsRouter(d.secretsService, d.refreshPtyEnv));
  app.use('/api/settings/harnesses', createHarnessSettingsRouter(d.db, d.secretsService, d.refreshPtyEnv));
  app.use('/api/settings/telemetry', createTelemetrySettingsRouter(d.db));
  app.use('/api/transcribe', createTranscribeRouter(new TranscriptionService(d.secretsService)));
  app.use('/api/setup', createSetupRouter(d.db, d.secretsService));
  app.use('/api/sessions/:id/files', createFilesRouter(d.db));
  app.use('/api/sessions/:id/git', createGitRouter(d.db));
  app.use('/api/auth-requests', createAuthRouter(d.authRequestService));
  app.use('/api/claude-auth', createClaudeAuthRouter(d.claudeLogin));
  app.use('/api/state', createStateRouter(d.db));
  app.use('/api/integrations', createIntegrationsRouter(d.integrationsService));
  app.use('/api/push', createPushRouter(d.pushService));
  app.use('/api/tools', createToolsRouter({ base: d.toolsBase, prober: d.toolsAuth }));
  app.use('/api/update', createUpdateRouter(d.broadcaster, d.repoRoot, d.db));
  app.use('/api/appearance', createAppearanceRouter(d.dataDir));
  app.use('/api/watches', createWatchesRouter(d.db, d.watchCatchUp));
  app.use('/api/analytics', createAnalyticsRouter(d.db));
  if (d.usageLimits) app.use('/api', createUsageLimitsRouter(d.db, d.usageLimits.snapshots, { accountFor: d.usageLimits.accountFor }));
  if (d.endless) app.use('/api/endless', createEndlessRouter(d.endless));
  else app.use('/api/endless', ownerOnly, (_req, res) => { res.status(503).json({ error: 'Chat is unavailable' }); });
}
