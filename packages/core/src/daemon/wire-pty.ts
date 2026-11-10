import type Database from 'better-sqlite3';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import type { AgentService } from '../agents/service.js';
import type { StatusService } from '../status/service.js';
import type { AuthRequestService } from '../auth/service.js';
import type { ClaudeLoginService } from '../auth/claude-login.js';
import type { SecretsService } from '../secrets/service.js';
import type { OsConnectionsProvider } from '../integrations/os-provider.js';
import type { UsageLimitService } from '../limits/service.js';
import type { ThreadAutoNamer } from '../sessions/thread-auto-namer.js';
import type { ToolAuthProber } from '../tools/auth-probe.js';
import type { IStructuredManager } from '../structured/manager.js';
import type { EventBroadcaster } from '../ws/events.js';
import { PtyLimitWatcher } from '../limits/pty-watch.js';
import { TerminalMonitor } from '../terminal-monitor.js';
import { aggregateSessionStatus } from '../status/aggregate.js';
import { opencodeKeySecretName, skipClaudeAgentSummaries } from '../settings/harness-settings.js';
import { setClaudeProbeEnv } from '../providers/claude-prompt-file.js';
import { setProviderProbeEnv } from '../setup/detect.js';
import { withShimPath } from '../auth/shim.js';
import { installAgentSummaryHook, withAgentSummaryPreload } from '../providers/claude-agent-summary.js';
import { getToolsSpawnEnv } from '../tools/status.js';
import type { PtyLike } from './noop-pty.js';

export interface SpawnEnvInputs {
  db: Database.Database;
  dataDir: string;
  env: NodeJS.ProcessEnv;
  toolsBase: string;
  /** The env of the browser shim (`$BROWSER`), from platform.installBrowserShim. Empty when no shim is installed. */
  shimEnv: () => Record<string, string>;
  /** The daemon's own address; null until it is known. A thread is never told an address that the daemon does not hold. */
  daemonApi: () => string | null;
  claudeLogin: ClaudeLoginService;
  osConnections: OsConnectionsProvider;
  secretsService: SecretsService;
  toolsAuth: ToolAuthProber;
  ptyManager: PtyLike;
  /** Every manager that starts a process: the threads' managers and Chat's own. */
  managers: () => Iterable<IStructuredManager>;
  /** The opencode manager, when the build has one: it also gets the OpenRouter key. */
  opencode: () => IStructuredManager | undefined;
}

export interface SpawnEnv {
  /** Build the env again and hand it to every manager. Runs on a secrets, sign-in or settings change. */
  refresh(): void;
  /** The env of the last refresh. */
  current(): Record<string, string>;
}

/**
 * The env that every thread process starts with: the browser shim, the daemon's address, the saved Claude
 * sign-in, the tools OS brokers, the base Doppler env and the bundled tools.
 */
export function wireSpawnEnv(i: SpawnEnvInputs): SpawnEnv {
  const { db, dataDir, claudeLogin, osConnections, secretsService, toolsAuth } = i;
  let current: Record<string, string> = {};
  const agentSummaryHook = installAgentSummaryHook(dataDir);
  // Resolve the OpenCode/OpenRouter key from Doppler BY CONFIGURED NAME (settings/harness-
  // settings.ts) and layer it onto the opencode children's env as OPENROUTER_API_KEY.
  // Async on purpose (Doppler round-trip) atop the sync env refresh; re-fired on boot,
  // secrets connection changes, any secret write, and harness-settings PUTs — so saving or
  // renaming the key takes effect on the next spawn without a restart. Resolution failure
  // is fine: opencode falls back to its own auth store.
  const refreshOpencodeKeyEnv = (baseEnv: Record<string, string>) => {
    const opencode = i.opencode();
    if (!opencode) return;
    void (async () => {
      try {
        const value = await secretsService.getSecret(opencodeKeySecretName(db));
        if (value) opencode.setDefaultEnv({ ...baseEnv, OPENROUTER_API_KEY: value });
      } catch { /* Doppler not connected — auth store fallback */ }
    })();
  };
  const refresh = () => {
    // claudeLogin and osConnections are the hosted box's two spawn-env providers:
    // the user's own Claude credential, and the MCP tools OS brokers per spawn. Both
    // are no-ops on a local daemon (no OS_BASE_URL, no login session), so one
    // composition serves both deployments rather than forking the spawn path.
    const api = i.daemonApi();
    const spawnEnv: Record<string, string> = {
      ...i.shimEnv(),
      // Not a secret: the address that a thread key may be sent to. The key itself is never here.
      ...(api ? { DISPATCH_API: api } : {}),
      ...claudeLogin.getSpawnEnv(),
      ...osConnections.getSpawnEnv(),
      ...secretsService.getBaseSpawnEnv(),
      ...getToolsSpawnEnv({ base: i.toolsBase }),
    };
    // Each of those builds its own PATH off process.env.PATH, so the last spread wins
    // and the earlier prefixes are lost. Re-assert the shim's bin dir explicitly — without
    // it $BROWSER points at a `dispatch-open` that is not on PATH, and the whole
    // browser-auth relay silently does nothing. On a hosted box that relay is the ONLY
    // route an OAuth URL has to the person signing in: there is no local browser.
    spawnEnv.PATH = withShimPath(dataDir, spawnEnv.PATH);
    // Every Claude Code thread preloads the agent_summary off-switch (claude-agent-summary.ts).
    // Settings → Agents → Claude Code turns it off; the PUT re-runs this refresh.
    const bunOptions = withAgentSummaryPreload(i.env.BUN_OPTIONS, skipClaudeAgentSummaries(db) ? agentSummaryHook : null);
    if (bunOptions) spawnEnv.BUN_OPTIONS = bunOptions;
    toolsAuth.setSpawnEnv(spawnEnv);
    // The Claude version check reads the same `claude` the agents will run.
    setClaudeProbeEnv(spawnEnv);
    // The sign-in check that gates new threads asks the CLI under the same env, so
    // Dispatch's saved Claude token counts even when the CLI's own login has expired.
    setProviderProbeEnv(spawnEnv);
    current = spawnEnv;
    i.ptyManager.setDefaultEnv(spawnEnv);
    // The ACP children (Grok, OpenCode) run real tools directly (no app-server
    // indirection), so they need the same spawn env a PTY thread gets — secrets, bundled
    // tools, the browser shim.
    for (const manager of i.managers()) manager.setDefaultEnv(spawnEnv);
    refreshOpencodeKeyEnv(spawnEnv);
  };
  return { refresh, current: () => current };
}

export interface PtyInputs {
  db: Database.Database;
  ptyManager: PtyLike;
  broadcaster: EventBroadcaster;
  agentService: AgentService;
  statusService: StatusService;
  authRequestService: AuthRequestService;
  usageLimits: UsageLimitService;
  threadAutoNamer: ThreadAutoNamer;
}

export interface PtyServices {
  terminalMonitor: TerminalMonitor;
  ptyLimits: PtyLimitWatcher;
}

/**
 * The output and the exit of every CLI (PTY) thread: the activity monitor, the agent runner's stream parser,
 * the usage-limit banner, and the status of the thread and of its project when the process ends.
 */
export function wirePty(i: PtyInputs): PtyServices {
  const { db, ptyManager, broadcaster, agentService, statusService, authRequestService, usageLimits, threadAutoNamer } = i;
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
  return { terminalMonitor, ptyLimits };
}
