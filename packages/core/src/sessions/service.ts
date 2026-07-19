import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import * as agentsDb from '../db/agents.js';
import * as appState from '../db/app-state.js';
import * as messageSourceDb from '../db/message-source.js';
import * as watchesDb from '../db/watches.js';
import { getProvider } from '../providers/registry.js';
import { PTYManager } from '../pty/manager.js';
import type { Session, CreateSessionInput } from '../types.js';
import { rowToSession } from '../types.js';
import type { TerminalType } from '../db/terminals.js';
import type { StatusHooksInjection } from '../providers/types.js';
import { composeInjection, type McpServerSpec } from '../mcp/injection.js';
import { parseClaudeTranscript, type ConvItem } from '../conversation/transcript.js';
import { platform } from '../platform/index.js';
import { systemPromptFor, modelFor, buildPeerPrompt } from '../overseer/prompts.js';
import { readSessionBackfill, readTerminalTokenUsage, transcriptTailStatus, findNewestUnresolvedUserUuid, applyDurableSources } from './cc-sessions.js';
import { TERMINAL_ID_ENV_VAR } from '../auth/shim.js';
import { withAutoArchive, DEFAULT_AUTO_ARCHIVE_MS } from './auto-archive.js';

interface StatusContext {
  serverUrl: string;
  /** Directory where per-terminal Claude hook settings files are written. */
  hooksDir: string;
  /** Absolute path to the Codex notify helper script. */
  codexHelperPath: string;
}

/** Grace period before the boot kickstart runs, so a save-burst on shutdown can coalesce. */
const KICKSTART_SETTLE_MS = 4000;

/** Build an Error carrying an HTTP `status` so a route can map it to a response code. */
function transportError(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

/** The re-prompt delivered to a structured thread that the last daemon shutdown interrupted mid-turn. */
const KICKSTART_CONTINUE_PROMPT =
  '⚙️ Dispatch restarted and interrupted you mid-task — re-read your last steps above and continue your ' +
  'mission from where you left off. If you had already finished, briefly say so instead of redoing work.';

export class SessionService {
  /** Supplies the Doppler MCP spec for spawned CLIs; set by the server wiring. */
  private secretsServerSpec: (() => { spec: McpServerSpec | null; prompt: string | null }) | null = null;
  /** Supplies the catalog MCP specs for spawned CLIs; set by the server wiring. */
  private integrationsSpecs: (() => McpServerSpec[]) | null = null;
  /** How spawned CLIs phone home with lifecycle events; set by the server wiring. */
  private statusContext: StatusContext | null = null;
  /** Supplies a tools-awareness note injected into the developer instructions; set by server wiring. */
  private toolsAwareness?: () => string | null;
  /** Drives structured (stream-json) sessions for claude-code threads; set by server wiring. */
  private structuredManager?: import('../structured/manager.js').IStructuredManager;
  /** Drives structured (app-server) sessions for codex threads; set by server wiring only
   *  when CODEX_PRETTY_ENABLED. Undefined ⇒ codex has no structured transport (Phase A). */
  private codexStructuredManager?: import('../structured/manager.js').IStructuredManager;
  /** Override for structured command (test seam: lets tests spawn fake-claude instead of real claude). */
  private structuredCommandOverride?: { command: string; args: string[] };

  constructor(
    private db: Database.Database,
    private ptyManager: PTYManager,
    /**
     * Anchor path for per-spawn MCP configs — only its DIRECTORY is used (see
     * `perTerminalMcpConfigPath`); the file at this exact path is never written
     * directly, since every spawn gets its own `thread-<terminalId>.mcp.json`
     * beside it. Defaults to ~/.dispatch/mcp.json.
     */
    private readonly mcpConfigPath: string = path.join(os.homedir(), '.dispatch', 'mcp.json'),
  ) {}

  setSecretsServerSpec(fn: () => { spec: McpServerSpec | null; prompt: string | null }): void {
    this.secretsServerSpec = fn;
  }

  setIntegrationsSpecs(fn: () => McpServerSpec[]): void {
    this.integrationsSpecs = fn;
  }

  setToolsAwareness(fn: () => string | null): void {
    this.toolsAwareness = fn;
  }

  setStructuredManager(m: import('../structured/manager.js').IStructuredManager): void {
    this.structuredManager = m;
    // Persist the claude session_id (surfaced from the structured init event) onto the
    // terminal's external_id, mirroring how the PTY path captures session ids. This is
    // what lets us resume the SAME conversation after a daemon restart. First-write-wins
    // (a `-r` resume keeps the same id, so we never need to overwrite).
    m.on('session', (terminalId: string, sessionId: string) => {
      try {
        const t = terminalsDb.getById(this.db, terminalId);
        if (t && !t.external_id && sessionId) terminalsDb.updateExternalId(this.db, terminalId, sessionId);
      } catch { /* best effort */ }
    });
    // Durable source persistence: the manager emits this once a tagged turn's `result`
    // lands (its transcript lines are guaranteed flushed by then — see manager.ts's
    // `result` handler). Resolve it to the newest not-yet-recorded real user-text uuid in
    // this terminal's transcript and persist the pair, so a later disk-hydrated chat (after
    // the CLI process has exited) can still show the "via Dispatch" badge (see
    // readSessionBackfill's caller below and getConversation, both of which merge this back in).
    m.on('message-source', (terminalId: string, source: messageSourceDb.MessageSource) => {
      try {
        const t = terminalsDb.getById(this.db, terminalId);
        if (!t) return;
        const session = sessionsDb.getById(this.db, t.session_id);
        const workDir = t.working_dir || session?.working_dir;
        const sessionId = t.external_id;
        if (!workDir || !sessionId) return;
        const exclude = messageSourceDb.listUuids(this.db, terminalId);
        const uuid = findNewestUnresolvedUserUuid(workDir, sessionId, exclude);
        if (uuid) messageSourceDb.record(this.db, terminalId, uuid, source);
      } catch { /* best effort — a missed tag just degrades to a plain bubble, never an error */ }
    });
  }

  setStructuredCommandOverride(cmd: { command: string; args: string[] }): void { this.structuredCommandOverride = cmd; }

  /**
   * Wire the Codex structured (app-server) manager. Only called by server wiring when
   * CODEX_PRETTY_ENABLED — until then `structuredManagerFor('codex')` is undefined and
   * codex threads have only the PTY transport.
   */
  setCodexStructuredManager(m: import('../structured/manager.js').IStructuredManager): void {
    this.codexStructuredManager = m;
  }

  /**
   * The structured manager for a terminal type, or undefined when that type has no
   * structured transport. Both managers satisfy IStructuredManager, so every structured
   * operation routes through this one accessor:
   *   claude-code → the Claude stream-json manager
   *   codex       → the Codex app-server manager (only when CODEX_PRETTY_ENABLED)
   */
  structuredManagerFor(type: string): import('../structured/manager.js').IStructuredManager | undefined {
    if (type === 'claude-code') return this.structuredManager;
    if (type === 'codex') return this.codexStructuredManager;
    return undefined;
  }

  /** Resolve the structured manager for a terminal id (looks up its type first). Public so the
   *  structured-ws upgrade handler can pick the RIGHT manager (claude vs codex) per connection. */
  structuredManagerForTerminal(terminalId: string): import('../structured/manager.js').IStructuredManager | undefined {
    const t = terminalsDb.getById(this.db, terminalId);
    return t ? this.structuredManagerFor(t.type) : undefined;
  }

  setStatusContext(ctx: StatusContext): void {
    this.statusContext = ctx;
  }

  /**
   * Resolve the per-terminal status-hooks injection: ask the provider to shape
   * the plan, then do the IO (write the Claude settings file) so the build*
   * commands receive ready-to-use args. No-op until the server sets the context.
   */
  private buildStatusHooks(terminalId: string, type: string): StatusHooksInjection | undefined {
    const ctx = this.statusContext;
    if (!ctx) return undefined;
    const provider = getProvider(type);
    const plan = provider.buildStatusHooks?.({
      serverUrl: ctx.serverUrl,
      terminalId,
      codexHelperPath: ctx.codexHelperPath,
    });
    if (!plan) return undefined;
    if (plan.claudeSettings) {
      try {
        fs.mkdirSync(ctx.hooksDir, { recursive: true });
        const file = path.join(ctx.hooksDir, `${terminalId}.json`);
        fs.writeFileSync(file, JSON.stringify(plan.claudeSettings, null, 2));
        return { claudeSettingsPath: file };
      } catch {
        return undefined; // hooks are best-effort; never block a spawn
      }
    }
    if (plan.codexArgs) return { codexNotifyArgs: plan.codexArgs };
    return undefined;
  }

  create(input: CreateSessionInput): Session {
    const id = uuid();
    const name = input.name || 'New Project';

    sessionsDb.create(this.db, {
      id,
      provider: input.provider || 'claude-code',
      name,
      workingDir: input.workingDir || '~',
    });

    return rowToSession(sessionsDb.getById(this.db, id)!);
  }

  get(id: string): Session | null {
    const row = sessionsDb.getById(this.db, id);
    return row ? rowToSession(row) : null;
  }

  list(status?: string): Session[] {
    return sessionsDb.list(this.db, status).map(rowToSession);
  }

  reorderSessions(order: string[]): void {
    for (let i = 0; i < order.length; i++) {
      this.db.prepare('UPDATE sessions SET sort_order = ? WHERE id = ?').run(i, order[i]);
    }
  }

  update(id: string, fields: { name?: string; notes?: string; tags?: string[] }): Session | null {
    sessionsDb.update(this.db, id, fields);
    return this.get(id);
  }

  relaunch(id: string): Session | null {
    const row = sessionsDb.getById(this.db, id);
    if (!row) return null;

    // Find the first terminal for this session to relaunch
    const terminals = terminalsDb.listBySession(this.db, id);
    if (terminals.length > 0) {
      const terminal = terminals[0];
      this.relaunchTerminal(terminal.id);
    } else {
      // Legacy: no terminal records yet, use session-level relaunch
      if (this.ptyManager.isAlive(id)) return rowToSession(row);

      const provider = getProvider(row.provider);
      try {
        const cmd = row.external_id
          ? provider.buildResumeCommand({ externalSessionId: row.external_id, workDir: row.working_dir })
          : provider.buildNewCommand({ workDir: row.working_dir });

        const pid = this.ptyManager.spawn(id, cmd.command, cmd.args, row.working_dir);
        sessionsDb.updatePid(this.db, id, pid);
        sessionsDb.setError(this.db, id, '');
      } catch (err: any) {
        sessionsDb.setError(this.db, id, err.message);
      }
    }

    return rowToSession(sessionsDb.getById(this.db, id)!);
  }

  stop(id: string): void {
    // Stop all terminals for this session
    const terminals = terminalsDb.listBySession(this.db, id);
    for (const terminal of terminals) {
      this.ptyManager.kill(terminal.id);
      this.structuredManagerFor(terminal.type)?.kill(terminal.id);
      terminalsDb.updatePid(this.db, terminal.id, null);
    }

    // Legacy: also kill by session ID in case no terminal records
    this.ptyManager.kill(id);
    sessionsDb.updateStatus(this.db, id, 'waiting');
    sessionsDb.updatePid(this.db, id, null);
  }

  archive(id: string): void {
    // Kill all terminals
    const terminals = terminalsDb.listBySession(this.db, id);
    for (const terminal of terminals) {
      if (this.ptyManager.isAlive(terminal.id)) this.ptyManager.kill(terminal.id);
      this.structuredManagerFor(terminal.type)?.kill(terminal.id);
    }
    // Drop the agent_runs → terminals FK references first; otherwise the hard
    // delete below trips a FOREIGN KEY constraint for any session that ever had
    // a scheduled-agent run, and the whole archive fails.
    agentsDb.clearTerminalRefsBySession(this.db, id);
    // thread_watches has no FK to terminals (rows outlive a deleted watcher/target by
    // design — see db/watches.ts), so sweep every watch touching this session's terminals
    // before the bulk hard-delete below, while they can still be enumerated. Mirrors
    // removeTerminal's single-thread sweep (see watchesDb.removeForTerminal there).
    for (const terminal of terminals) {
      watchesDb.removeForTerminal(this.db, terminal.id);
    }
    terminalsDb.removeBySession(this.db, id);

    if (this.ptyManager.isAlive(id)) this.ptyManager.kill(id);
    sessionsDb.archive(this.db, id);
  }

  // --- Terminal-level operations ---

  createTerminal(sessionId: string, type: TerminalType, label?: string, skipPermissions?: boolean, workingDir?: string, externalId?: string, config?: Record<string, any>): terminalsDb.Terminal {
    const session = sessionsDb.getById(this.db, sessionId);
    if (!session) throw new Error('Session not found');

    const resolvedDir = workingDir
      ? workingDir.replace(/^~/, os.homedir())
      : session.working_dir;

    if (workingDir) {
      appState.set(this.db, 'last_directory', resolvedDir);
    }

    const terminalId = uuid();
    const labelSource: 'user' | 'default' = label ? 'user' : 'default';
    const displayLabel = label || this.defaultTerminalLabel(sessionId, type);

    terminalsDb.create(this.db, {
      id: terminalId,
      sessionId,
      type,
      label: displayLabel,
      labelSource,
      skipPermissions,
      workingDir: resolvedDir,
      externalId,
      config,
    });

    try {
      this.spawnTerminal(terminalId);
    } catch (err: any) {
      terminalsDb.remove(this.db, terminalId);
      throw new Error(`Failed to start ${displayLabel}: ${err.message}`);
    }

    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, terminalId)!);
  }

  /**
   * Create a structured terminal row WITHOUT spawning its process — the "create"
   * half of createTerminal, minus the spawn. The row is persisted as
   * `status='queued'` with the seed task parked in `config.queuedTask` and the
   * `config.queued=true` guard flag set (which keeps ensureStructuredAlive from
   * lazily reviving it — see the guard there). No CLI is launched until
   * `startQueuedTerminal` promotes it: strips the flags, spawns, and delivers the
   * parked task. Lets the coordinator queue work up front without paying for a
   * live process per queued agent.
   */
  createQueuedTerminal(sessionId: string, type: TerminalType, label: string | undefined, config: Record<string, any> | undefined, task: string): terminalsDb.Terminal {
    const session = sessionsDb.getById(this.db, sessionId);
    if (!session) throw new Error('Session not found');

    const terminalId = uuid();
    const labelSource: 'user' | 'default' = label ? 'user' : 'default';
    const displayLabel = label || this.defaultTerminalLabel(sessionId, type);

    terminalsDb.create(this.db, {
      id: terminalId,
      sessionId,
      type,
      label: displayLabel,
      labelSource,
      workingDir: session.working_dir,
      config: { ...(config ?? {}), queued: true, queuedTask: task },
    });
    terminalsDb.updateStatus(this.db, terminalId, 'queued');

    // dependsOn may already be satisfied (the depended-on agent finished — or was
    // archived — before this one was even queued). Don't leave it waiting forever
    // on an `idle` event that already fired; promote it right away.
    const dependsOn = typeof config?.dependsOn === 'string' ? config.dependsOn : '';
    if (dependsOn && this.isAgentDone(dependsOn)) {
      this.startQueuedTerminal(terminalId, this.composeDependentTask(dependsOn, task));
    }

    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, terminalId)!);
  }

  /**
   * Promote a queued terminal (created via createQueuedTerminal) to a live one:
   * strip the `queued`/`queuedTask`/`dependsOn` markers from its config, reset
   * status off 'queued', spawn its process, then deliver the parked task — or
   * `taskOverride` in its place when given (used by the `dependsOn` auto-start
   * path to inject the finished dependency's output ahead of the original task;
   * a plain manual start delivers the original task unchanged). Returns the
   * terminal as-is when it isn't actually queued (idempotent), or null when it
   * doesn't exist.
   */
  startQueuedTerminal(terminalId: string, taskOverride?: string): terminalsDb.Terminal | null {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return null;
    let config: Record<string, any> = {};
    try { config = JSON.parse(terminal.config || '{}'); } catch { /* default {} */ }
    if (config.queued !== true) return terminalsDb.rowToTerminal(terminal); // not queued — nothing to promote

    const task = typeof taskOverride === 'string' ? taskOverride : (typeof config.queuedTask === 'string' ? config.queuedTask : '');
    // Strip the queued markers BEFORE spawning so the row reads as a normal live
    // thread (and the ensureStructuredAlive guard no longer bails on it). dependsOn
    // is stripped too — once started, whether early (override) or auto (dependency
    // met), it's no longer meaningfully "waiting" on anything.
    const { queued, queuedTask, dependsOn, ...rest } = config;
    terminalsDb.updateConfig(this.db, terminalId, rest);
    terminalsDb.updateStatus(this.db, terminalId, 'waiting');

    this.spawnTerminal(terminalId);
    if (task) this.sendStructuredMessage(terminalId, task);

    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, terminalId)!);
  }

  /**
   * Create a terminal that launches the provider in autonomous "runner" mode:
   * the prompt is passed as a launch arg so the agent executes it to completion
   * (and the process exits when done) instead of opening an interactive REPL
   * with text typed into it. The prompt + runner flag are persisted in the
   * terminal's config so a relaunch re-runs the same prompt. Used by agent runs.
   */
  createRunnerTerminal(sessionId: string, type: TerminalType, label: string | undefined, workingDir: string | undefined, prompt: string): terminalsDb.Terminal {
    const session = sessionsDb.getById(this.db, sessionId);
    if (!session) throw new Error('Session not found');

    const resolvedDir = workingDir
      ? workingDir.replace(/^~/, os.homedir())
      : session.working_dir;

    if (workingDir) {
      appState.set(this.db, 'last_directory', resolvedDir);
    }

    const terminalId = uuid();
    const labelSource: 'user' | 'default' = label ? 'user' : 'default';
    const displayLabel = label || this.defaultTerminalLabel(sessionId, type);

    terminalsDb.create(this.db, {
      id: terminalId,
      sessionId,
      type,
      label: displayLabel,
      labelSource,
      skipPermissions: true,
      workingDir: resolvedDir,
      config: { runner: true, runnerPrompt: prompt },
    });

    try {
      this.spawnTerminal(terminalId);
    } catch (err: any) {
      terminalsDb.remove(this.db, terminalId);
      throw new Error(`Failed to start ${displayLabel}: ${err.message}`);
    }

    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, terminalId)!);
  }

  /**
   * Branch (fork) a Claude Code thread into a NEW thread. Resolves the source
   * thread's session id, then creates a terminal that forks it on first spawn
   * (config.branchFrom → provider.buildBranchCommand → `claude -r <id> --fork-session`).
   * The original thread is untouched. Throws with `.status = 422` if the source
   * doesn't have a session id yet.
   */
  branchTerminal(sourceTerminalId: string): terminalsDb.Terminal {
    const source = terminalsDb.getById(this.db, sourceTerminalId);
    if (!source) throw new Error('Thread not found');
    const provider = getProvider(source.type);
    if (!provider.buildBranchCommand) throw new Error('This thread type cannot be branched');
    const dir = source.working_dir || sessionsDb.getById(this.db, source.session_id)?.working_dir;
    if (!dir) throw new Error('Session not found');
    const sourceSessionId = source.external_id || this.recoverSessionId(sourceTerminalId, dir);
    if (!sourceSessionId) {
      const e: any = new Error('Thread has no session yet — let it start, then branch.');
      e.status = 422;
      throw e;
    }

    const terminalId = uuid();
    terminalsDb.create(this.db, {
      id: terminalId,
      sessionId: source.session_id,
      type: source.type,
      label: `${source.label} (branch)`,
      // Deliberate, derived-from-source name — not a placeholder — so it's frozen
      // like a user-typed label rather than eligible for later auto-renaming.
      labelSource: 'user',
      skipPermissions: true,
      workingDir: dir,
      config: { branchFrom: sourceSessionId },
    });
    try {
      this.spawnTerminal(terminalId);
    } catch (err: any) {
      terminalsDb.remove(this.db, terminalId);
      throw new Error(`Failed to branch: ${err.message}`);
    }
    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, terminalId)!);
  }

  // Create a non-PTY tab (browser, notes)
  createTab(sessionId: string, type: string, label?: string, config?: Record<string, any>): terminalsDb.Terminal {
    const session = sessionsDb.getById(this.db, sessionId);
    if (!session) throw new Error('Session not found');

    const tabId = uuid();
    const labelSource: 'user' | 'default' = label ? 'user' : 'default';
    const displayLabel = label || type;
    terminalsDb.create(this.db, {
      id: tabId,
      sessionId,
      type,
      label: displayLabel,
      labelSource,
      config,
    });
    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, tabId)!);
  }

  // Update any tab (rename, update config)
  updateTab(tabId: string, fields: { label?: string; config?: Record<string, any> }): terminalsDb.Terminal | null {
    const row = terminalsDb.getById(this.db, tabId);
    if (!row) return null;
    if (fields.label) terminalsDb.updateLabel(this.db, tabId, fields.label);
    if (fields.config) terminalsDb.updateConfig(this.db, tabId, fields.config);
    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, tabId)!);
  }

  /**
   * Turn a thread's auto-archive policy on or off. Merges server-side: the
   * generic PATCH /terminals/:id replaces the config blob wholesale (and must
   * keep doing so — unpin relies on it), so a partial config from the client
   * would silently drop `transport`, `role`, `agentType`, etc.
   */
  setAutoArchive(terminalId: string, enabled: boolean, ms: number = DEFAULT_AUTO_ARCHIVE_MS): terminalsDb.Terminal | null {
    const row = terminalsDb.getById(this.db, terminalId);
    if (!row) return null;
    const current = terminalsDb.rowToTerminal(row).config;   // malformed blob parses to {}
    terminalsDb.updateConfig(this.db, terminalId, withAutoArchive(current, enabled, ms));
    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, terminalId)!);
  }

  /**
   * Toggle per-thread push alerts (the bell). Merges server-side for the same
   * reason as setAutoArchive: the generic PATCH replaces the config blob wholesale.
   * Disable deletes the key so configs don't accumulate `alertsEnabled: false`.
   */
  setAlertsEnabled(terminalId: string, enabled: boolean): terminalsDb.Terminal | null {
    const row = terminalsDb.getById(this.db, terminalId);
    if (!row) return null;
    const config = { ...terminalsDb.rowToTerminal(row).config } as Record<string, any>;
    if (enabled) config.alertsEnabled = true; else delete config.alertsEnabled;
    terminalsDb.updateConfig(this.db, terminalId, config);
    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, terminalId)!);
  }

  reorderTabs(sessionId: string, order: string[]): void {
    for (let i = 0; i < order.length; i++) {
      terminalsDb.updateSortOrder(this.db, order[i], i);
    }
  }

  moveTab(tabId: string, toSessionId: string): terminalsDb.Terminal | null {
    const row = terminalsDb.getById(this.db, tabId);
    if (!row) return null;
    terminalsDb.updateSessionId(this.db, tabId, toSessionId);
    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, tabId)!);
  }

  listTerminals(sessionId: string): terminalsDb.Terminal[] {
    // Exclude agent-run "runner" terminals: they belong to the agent run's
    // polished RunnerView (steps/plan/HUD), not the project's thread list — where
    // opening one would just show the raw stream-json the runner emits.
    return terminalsDb.listBySession(this.db, sessionId)
      .map(terminalsDb.rowToTerminal)
      .filter((t) => !(t.config as { runner?: boolean } | undefined)?.runner);
  }

  getTerminal(terminalId: string): terminalsDb.Terminal | null {
    const row = terminalsDb.getById(this.db, terminalId);
    return row ? terminalsDb.rowToTerminal(row) : null;
  }

  /**
   * Read + parse a WINDOW of the live transcript for a terminal's session (View).
   * The transcript is addressed by complete-JSONL-line index:
   *   - default (initial load): the most recent `limit` lines.
   *   - `since`: lines after index `since` (polling for new messages at the bottom).
   *   - `before`: the `limit` lines ending just before index `before` (loading
   *     older history at the top, for reverse infinite scroll).
   *   - `beforeUuid`: like `before`, but the anchor is the transcript-line `uuid` of
   *     the OLDEST item a caller has already rendered (from a ws replay, which has no
   *     line index of its own — see ConvItem.uuid). Resolved to a line index here so
   *     the very first reverse-scroll page can fetch genuinely-older content instead
   *     of defaulting to the newest window, which would just overlap what's already
   *     on screen. Falls back to the newest-window default when the uuid isn't found
   *     (e.g. it hasn't reached disk yet, or predates this transcript file).
   * Returns the parsed `items`, `cursor` (= total line count, the bottom edge for
   * polling), `startLine` (top edge of the returned window), and `hasMore`
   * (whether older lines exist above the window). Claude Code only for now.
   */
  getConversation(
    terminalId: string,
    opts: { since?: number; before?: number; beforeUuid?: string; limit?: number } = {},
  ): { items: ConvItem[]; cursor: number; startLine: number; hasMore: boolean; unsupported?: boolean } {
    const empty = { items: [] as ConvItem[], cursor: 0, startLine: 0, hasMore: false };
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return empty;
    if (terminal.type !== 'claude-code') return { ...empty, unsupported: true };

    const session = sessionsDb.getById(this.db, terminal.session_id);
    const workDir = terminal.working_dir || session?.working_dir;
    if (!workDir) return empty;

    const dir = platform.claudeProjectDir(workDir);
    // external_id is normally captured at spawn; when it wasn't, recover it from the
    // project's transcript files so the thread still renders in View.
    const sessionId = terminal.external_id || this.recoverSessionId(terminalId, dir);
    if (!sessionId) return empty;

    let raw: string;
    try { raw = fs.readFileSync(path.join(dir, `${sessionId}.jsonl`), 'utf8'); } catch { return empty; }

    // Consume only complete lines (the trailing element is an empty string after a
    // final newline, or a half-written entry) so we never parse a partial record.
    const usable = raw.split('\n').slice(0, -1);
    const total = usable.length;
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 200;

    // Resolve beforeUuid to a line index by scanning backward from the tail — the anchor
    // is always a recently-rendered ws item, so it's near the end, not deep in the file.
    let beforeFromUuid: number | undefined;
    if (opts.beforeUuid) {
      for (let i = total - 1; i >= 0; i--) {
        try { if (JSON.parse(usable[i])?.uuid === opts.beforeUuid) { beforeFromUuid = i; break; } } catch { /* partial/garbled line */ }
      }
    }

    let start: number;
    let end: number;
    if (beforeFromUuid !== undefined) {                       // precise anchor (scroll up, first page)
      end = beforeFromUuid;
      start = Math.max(0, end - limit);
    } else if (opts.before !== undefined && opts.before > 0) { // older window (scroll up)
      end = Math.min(opts.before, total);
      start = Math.max(0, end - limit);
    } else if (opts.since !== undefined && opts.since > 0) {  // new lines (poll)
      start = Math.min(opts.since, total);
      end = total;
    } else {                                                  // initial: most recent `limit`
      end = total;
      start = Math.max(0, total - limit);
    }

    // Parse per line so each item carries its source line index (enables jump-to).
    const items: ConvItem[] = [];
    for (let i = start; i < end; i++) {
      for (const it of parseClaudeTranscript(usable[i])) items.push({ ...it, line: i });
    }
    // Merge durably-stored `source` tags onto user turns (see db/message-source.ts) — the
    // REST transcript parser (conversation/transcript.ts) never sets this itself, matching
    // backfillEventsFromTranscript's identical on-disk gap (see the seedEvents merge above /
    // cc-sessions.ts's applyDurableSources). Fixes the archived-thread / loadOlder path,
    // where a chat is hydrated ENTIRELY from this endpoint (no live ws to fall back on).
    const userUuids = items.filter((it) => it.kind === 'user' && it.uuid).map((it) => it.uuid as string);
    if (userUuids.length) {
      const sourceByUuid = messageSourceDb.getForUuids(this.db, terminalId, userUuids);
      if (sourceByUuid.size) {
        for (const it of items) {
          if (it.kind === 'user' && it.uuid && sourceByUuid.has(it.uuid)) it.source = sourceByUuid.get(it.uuid);
        }
      }
    }
    return { items, cursor: total, startLine: start, hasMore: start > 0 };
  }

  /**
   * Full-history text search over a terminal's transcript. Returns matches with
   * their source line index (so View can load + scroll to that spot) and a short
   * snippet around the match. Newest matches first, capped for response size.
   */
  searchConversation(terminalId: string, query: string, limit = 200): { matches: { line: number; kind: string; snippet: string }[] } {
    const q = query.trim().toLowerCase();
    if (!q) return { matches: [] };
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal || terminal.type !== 'claude-code') return { matches: [] };
    const session = sessionsDb.getById(this.db, terminal.session_id);
    const workDir = terminal.working_dir || session?.working_dir;
    if (!workDir) return { matches: [] };
    const dir = platform.claudeProjectDir(workDir);
    const sessionId = terminal.external_id || this.recoverSessionId(terminalId, dir);
    if (!sessionId) return { matches: [] };
    let raw: string;
    try { raw = fs.readFileSync(path.join(dir, `${sessionId}.jsonl`), 'utf8'); } catch { return { matches: [] }; }

    const usable = raw.split('\n').slice(0, -1);
    const matches: { line: number; kind: string; snippet: string }[] = [];
    for (let i = usable.length - 1; i >= 0 && matches.length < limit; i--) { // newest first
      for (const it of parseClaudeTranscript(usable[i])) {
        const hay = `${it.text ?? ''} ${it.toolTitle ?? ''} ${it.toolDetail ?? ''}`;
        const at = hay.toLowerCase().indexOf(q);
        if (at >= 0) {
          matches.push({ line: i, kind: it.kind, snippet: snippetAround(hay, at, q.length) });
          break; // one match per line is enough
        }
      }
    }
    return { matches };
  }

  /**
   * Recover a missing transcript link, but ONLY when it's unambiguous: if the project's
   * Claude transcript dir holds exactly one *.jsonl, adopt it as the terminal's external_id
   * (so resume + future loads work too). With 0 files there's nothing to recover; with 2+ we
   * cannot tell the terminal's own transcript from unrelated `claude` sessions that share the
   * project dir (the user's own terminal runs, other coordinators), so we return null rather
   * than guess "newest" — guessing rendered a conversation the terminal never owned (issue #7:
   * a coordinator with no external_id surfaced a stranger's session). A terminal that actually
   * ran captured its external_id at the structured `init` event (first-write-wins, see
   * setStructuredManager), so it never depends on this fallback; a never-run coordinator
   * correctly falls back to the empty greeting instead of an arbitrary transcript.
   */
  private recoverSessionId(terminalId: string, dir: string): string | null {
    let files: { id: string; m: number }[];
    try {
      files = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ id: f.replace(/\.jsonl$/, ''), m: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
    } catch { return null; }
    if (files.length !== 1) return null; // 0 = nothing to recover; 2+ = ambiguous, don't guess
    try { terminalsDb.updateExternalId(this.db, terminalId, files[0].id); } catch { /* best effort */ }
    return files[0].id;
  }

  relaunchTerminal(terminalId: string): terminalsDb.Terminal | null {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return null;
    // Non-PTY tabs don't need relaunching
    if (!terminalsDb.isPtyType(terminal.type)) return terminalsDb.rowToTerminal(terminal);
    if (this.ptyManager.isAlive(terminalId)) return terminalsDb.rowToTerminal(terminal);

    const session = sessionsDb.getById(this.db, terminal.session_id);
    if (!session) return null;

    try {
      this.spawnTerminal(terminalId);
    } catch (err: any) {
      terminalsDb.updatePid(this.db, terminalId, null);
      terminalsDb.updateStatus(this.db, terminalId, 'error');
    }

    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, terminalId)!);
  }

  /** Restart a thread: kill the running process (if any) and re-spawn it fresh. */
  async restartTerminal(terminalId: string): Promise<terminalsDb.Terminal | null> {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return null;
    if (!terminalsDb.isPtyType(terminal.type)) return terminalsDb.rowToTerminal(terminal);

    if (this.ptyManager.isAlive(terminalId)) {
      // Wait for the old process to fully exit before respawning, so its async
      // exit handler can't delete the fresh PTY out from under us.
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; this.ptyManager.off('exit', onExit); resolve(); } };
        const onExit = (id: string) => { if (id === terminalId) finish(); };
        this.ptyManager.on('exit', onExit);
        this.ptyManager.kill(terminalId);
        setTimeout(finish, 3000);
      });
    }
    return this.relaunchTerminal(terminalId);
  }

  stopTerminal(terminalId: string): void {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return;
    this.ptyManager.kill(terminalId);
    this.structuredManagerFor(terminal.type)?.kill(terminalId);
    terminalsDb.updatePid(this.db, terminalId, null);
  }

  sendStructuredMessage(terminalId: string, content: string | import('../structured/manager.js').ContentBlock[], source?: import('../structured/manager.js').MessageSource): void {
    // Lazily resume a thread that died on a daemon restart (resumes the same claude
    // conversation when an external_id was captured) before delivering the message.
    const manager = this.structuredManagerForTerminal(terminalId);
    if (!manager?.isAlive(terminalId)) this.ensureStructuredAlive(terminalId);
    if (!manager?.isAlive(terminalId)) throw new Error('no structured session for terminal');
    manager.sendMessage(terminalId, content, source);
  }

  /**
   * The membrane's "up" channel. Inject a directive into the coordinator that supervises
   * `agentTerminalId`, if any: an agent never bothers the human directly — its questions and
   * lifecycle events surface to its project's coordinator (Dispatch), which decides what to do
   * (answer, ask the human itself, re-plan). Returns true when a live coordinator received the
   * note; false when the thread isn't a typed agent or the project has no coordinator.
   */
  private notifyCoordinatorOfAgent(agentTerminalId: string, note: string): boolean {
    const agent = terminalsDb.getById(this.db, agentTerminalId);
    if (!agent) return false;
    let cfg: Record<string, any> = {};
    try { cfg = JSON.parse(agent.config || '{}'); } catch { /* default {} */ }
    if (cfg.role !== 'agent') return false; // only agents escalate UP; coordinators/plain → human
    const coordinator = terminalsDb.listBySession(this.db, agent.session_id)
      .map(terminalsDb.rowToTerminal)
      .find((t) => t.type === 'claude-code' && !t.archivedAt && t.id !== agentTerminalId && t.config?.role === 'coordinator');
    if (!coordinator) return false;
    try {
      this.ensureStructuredAlive(coordinator.id); // a daemon restart may have killed it
      this.sendStructuredMessage(coordinator.id, note);
      return true;
    } catch { return false; }
  }

  /** Format an agent's pending AskUserQuestion as a directive the coordinator can act on. */
  private formatAgentQuestion(agentId: string, label: string, mission: string | null, questions: any[]): string {
    const qs = Array.isArray(questions) ? questions : [];
    const lines = qs.map((q: any, i: number) => {
      const header = (q?.header ?? `Q${i + 1}`).toString();
      const question = (q?.question ?? '').toString();
      const opts = Array.isArray(q?.options)
        ? q.options.map((o: any) => (typeof o === 'string' ? o : (o?.label ?? o?.name ?? ''))).filter(Boolean)
        : [];
      return `  • [${header}] ${question}${opts.length ? `\n    options: ${opts.join(' | ')}` : ''}`;
    });
    const headers = qs.map((q: any, i: number) => (q?.header ?? `Q${i + 1}`).toString());
    const exampleAnswers = headers.length
      ? `{ ${headers.map((h) => `"${h}": "<chosen option>"`).join(', ')} }`
      : '{ "<header>": "<chosen option>" }';
    return (
      `🔔 Your agent "${label}"${mission ? ` (mission "${mission}")` : ''} is PAUSED waiting on you to ` +
      `answer a question (it cannot proceed until you do):\n${lines.join('\n')}\n\n` +
      `Decide based on the mission and answer it now by calling:\n` +
      `answer_agent({ agentId: "${agentId}", answers: ${exampleAnswers} })\n` +
      `Pick from the listed options. Only raise it to the human yourself if you genuinely cannot decide.`
    );
  }

  /**
   * Membrane routing for an agent's pending AskUserQuestion: forward it to the project's
   * coordinator instead of the human. Returns true when a coordinator was notified (the caller
   * should keep the agent "working", not mark it needs_input); false to fall back to surfacing
   * the question to the human (the pending isn't a question, the thread isn't an agent, or the
   * project has no coordinator). Plain gated tools are never routed up — only questions.
   */
  routeAgentQuestionToCoordinator(agentTerminalId: string, pending: { toolName?: string; questions?: any[] }): boolean {
    if (!pending?.questions?.length) return false; // only AskUserQuestion escalates up; plain tools → human
    const agent = terminalsDb.getById(this.db, agentTerminalId);
    if (!agent) return false;
    let cfg: Record<string, any> = {};
    try { cfg = JSON.parse(agent.config || '{}'); } catch { /* default {} */ }
    const mission = typeof cfg.mission === 'string' && cfg.mission.trim() ? cfg.mission.trim() : null;
    const note = this.formatAgentQuestion(agentTerminalId, agent.label || 'agent', mission, pending.questions);
    return this.notifyCoordinatorOfAgent(agentTerminalId, note);
  }

  /**
   * Tell the project's coordinator that the user just stopped or interrupted one of its agents,
   * so Dispatch notices and reacts (checks in about why, re-plans) rather than silently losing
   * the agent. No-op when the thread isn't a typed agent or there's no coordinator.
   */
  noteAgentLifecycle(agentTerminalId: string, kind: 'stopped' | 'interrupted'): void {
    const agent = terminalsDb.getById(this.db, agentTerminalId);
    if (!agent) return;
    let cfg: Record<string, any> = {};
    try { cfg = JSON.parse(agent.config || '{}'); } catch { /* default {} */ }
    if (cfg.role !== 'agent') return;
    const mission = typeof cfg.mission === 'string' && cfg.mission.trim() ? cfg.mission.trim() : null;
    const note =
      `⚠️ The user just ${kind} your agent "${agent.label || 'agent'}"${mission ? ` (mission "${mission}")` : ''} ` +
      `[agentId ${agentTerminalId}] while it was working. They likely want a change of direction or noticed ` +
      `something off. Check in with the user about why and adjust: re-spawn with new guidance, redirect the ` +
      `work, or stand down. Do not silently ignore this.`;
    this.notifyCoordinatorOfAgent(agentTerminalId, note);
  }

  /** Summarize a user-sent payload for a coordinator notice: a string's first line
   *  (truncated per the `lastAssistantText` idiom); a block array's first text block, or a
   *  placeholder when it carries no text (e.g. an image-only send). */
  private summarizeUserPayload(payload: string | import('../structured/manager.js').ContentBlock[], max = 600): string {
    const raw = typeof payload === 'string'
      ? payload
      : ((payload.find((b: any) => b?.type === 'text') as any)?.text ?? '');
    if (!raw) return '(sent an image)';
    const firstLine = String(raw).split('\n')[0].trim();
    return firstLine.length > max ? firstLine.slice(0, max) + '…' : firstLine;
  }

  /**
   * Tell the project's coordinator that the user just messaged one of its agents DIRECTLY,
   * bypassing message_agent — so Dispatch notices a possible change of direction instead of
   * assuming the agent is still following its original instructions. No-op when the thread
   * isn't a typed agent or there's no coordinator.
   */
  noteUserMessageToAgent(agentTerminalId: string, payload: string | import('../structured/manager.js').ContentBlock[]): void {
    const agent = terminalsDb.getById(this.db, agentTerminalId);
    if (!agent) return;
    let cfg: Record<string, any> = {};
    try { cfg = JSON.parse(agent.config || '{}'); } catch { /* default {} */ }
    if (cfg.role !== 'agent') return;
    const mission = typeof cfg.mission === 'string' && cfg.mission.trim() ? cfg.mission.trim() : null;
    const summary = this.summarizeUserPayload(payload);
    const note =
      `💬 The user just sent your agent "${agent.label || 'agent'}"${mission ? ` (mission "${mission}")` : ''} ` +
      `[agentId ${agentTerminalId}] a message directly, not through you: "${summary}". This may change what you ` +
      `asked it to do. Read how it responds with read_agent and adjust — don't assume it's still following your ` +
      `original instructions.`;
    this.notifyCoordinatorOfAgent(agentTerminalId, note);
  }

  /** The agent's most recent assistant text, pulled live from the structured event ring
   *  (no transcript-file latency), truncated for a nudge. '' when there's none yet. */
  private lastAssistantText(terminalId: string, max = 600): string {
    const events = (this.structuredManagerForTerminal(terminalId)?.getEvents(terminalId) ?? []) as any[];
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e?.type === 'assistant' && Array.isArray(e.message?.content)) {
        const text = e.message.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text ?? '').join('').trim();
        if (text) return text.length > max ? text.slice(0, max) + '…' : text;
      }
    }
    return '';
  }

  /**
   * An agent's most recent assistant output. Tries the live structured event ring
   * first (lastAssistantText — no transcript-file latency); falls back to the
   * persisted transcript (same source read_agent/getConversation use) so an agent
   * with no live session — e.g. archived, or the daemon restarted since it ran —
   * still yields its output. '' when there's truly none.
   */
  private agentOutputText(terminalId: string, max = 600): string {
    const live = this.lastAssistantText(terminalId, max);
    if (live) return live;
    const text = this.getConversation(terminalId, { limit: 500 }).items
      .filter((it) => it.kind === 'assistant' && it.text)
      .map((it) => it.text)
      .join('\n\n')
      .trim();
    if (!text) return '';
    return text.length > max ? text.slice(0, max) + '…' : text;
  }

  /**
   * Whether a terminal has already finished at least one turn — used to detect an
   * already-satisfied `dependsOn` at queue time. Archived is always done (nothing
   * more will happen to it). Otherwise the status must be settled (not still
   * working, blocked on a human, or itself unstarted/queued) AND it must have
   * already produced output — a brand-new thread also reads status='waiting' (the
   * DB default) before its first turn even runs, so status alone would false-positive.
   */
  private isAgentDone(terminalId: string): boolean {
    const t = terminalsDb.getById(this.db, terminalId);
    if (!t) return false;
    if (t.archived_at) return true;
    if (t.status === 'working' || t.status === 'needs_input' || t.status === 'queued') return false;
    return this.agentOutputText(terminalId) !== '';
  }

  /**
   * The task a dependent agent receives once the agent it was waiting on has
   * finished: that agent's final output prepended as context, then the
   * dependent's originally parked task.
   */
  private composeDependentTask(finishedTerminalId: string, originalTask: string): string {
    const finished = terminalsDb.getById(this.db, finishedTerminalId);
    const finishedLabel = finished?.label || 'agent';
    const output = this.agentOutputText(finishedTerminalId) || '(no output captured)';
    return `The agent you were waiting on ("${finishedLabel}") has finished. Its final output:\n\n${output}\n\n---\n\nYour task: ${originalTask}`;
  }

  /**
   * Auto-start any agents queued with `dependsOn` pointing at this just-finished
   * terminal, feeding each the finished agent's output ahead of its parked task.
   */
  private startQueuedDependents(finishedTerminalId: string): void {
    for (const dep of terminalsDb.listQueuedDependents(this.db, finishedTerminalId)) {
      let depConfig: Record<string, any> = {};
      try { depConfig = JSON.parse(dep.config || '{}'); } catch { /* default {} */ }
      const originalTask = typeof depConfig.queuedTask === 'string' ? depConfig.queuedTask : '';
      this.startQueuedTerminal(dep.id, this.composeDependentTask(finishedTerminalId, originalTask));
    }
  }

  /**
   * An agent's turn just completed (the `result` event). Push an IMMEDIATE, concise completion
   * notice to its coordinator (the closed orchestration loop): a one-line summary from the agent's
   * last output + a pointer to read_agent for the full transcript, so Dispatch ingests the result
   * and decides the next step instead of forgetting the agent. Also auto-starts any queued agents
   * whose `dependsOn` pointed at this one. The dependents step runs regardless of role; the
   * coordinator notice below is agent-only / no-op for non-agents.
   */
  noteAgentCompletion(agentTerminalId: string): void {
    this.startQueuedDependents(agentTerminalId);
    const agent = terminalsDb.getById(this.db, agentTerminalId);
    if (!agent) return;
    let cfg: Record<string, any> = {};
    try { cfg = JSON.parse(agent.config || '{}'); } catch { /* default {} */ }
    if (cfg.role !== 'agent') return;
    this.persistAgentTokenUsage(agentTerminalId, agent, cfg);
    const mission = typeof cfg.mission === 'string' && cfg.mission.trim() ? cfg.mission.trim() : null;
    const summary = this.lastAssistantText(agentTerminalId);
    const note =
      `✅ Your agent "${agent.label || 'agent'}"${mission ? ` (mission "${mission}")` : ''} ` +
      `[agentId ${agentTerminalId}] just finished a turn.\n` +
      (summary ? `Its latest output: ${summary}\n\n` : '') +
      `Read its full work with read_agent({ agentId: "${agentTerminalId}" }), then decide the next step — ` +
      `ingest the result, hand it to another agent, spawn a follow-up, or report back to the user. Keep this ` +
      `brief unless it needs action; the user's own messages are always your top priority.`;
    this.notifyCoordinatorOfAgent(agentTerminalId, note);
  }

  /**
   * Persist an agent terminal's cumulative token usage into `config.totalTokens`
   * (and its output-only count into `config.outputTokens`) when its turn settles —
   * computed ONCE here (from the transcript's summed `usage` fields, via
   * readTerminalTokenUsage/sumTranscriptTokens) and written into config, mirroring
   * how `config.model` is captured at spawn time in spawnStructured. This is what
   * lets the Work-tab's Done cards show a token count for free (read off the
   * terminal row) instead of a per-card live fetch, which would be too expensive
   * across dozens of finished agents. `outputTokens` — tokens the agent actually
   * generated, excluding the cache-read/cache-write/input tokens that dominate the
   * cumulative total — is what the Done card displays, since it better reflects
   * "how much work this agent did" than the cache-dominated cumulative figure.
   * Best-effort: no-ops when there's no external_id yet or the transcript can't be read.
   */
  private persistAgentTokenUsage(terminalId: string, agent: terminalsDb.TerminalRow, cfg: Record<string, any>): void {
    if (!agent.external_id) return;
    const session = sessionsDb.getById(this.db, agent.session_id);
    const workDir = agent.working_dir || session?.working_dir;
    if (!workDir) return;
    const stats = readTerminalTokenUsage(workDir, agent.external_id);
    if (!stats || !stats.totalTokens) return;
    cfg.totalTokens = stats.totalTokens;
    cfg.outputTokens = stats.outputTokens;
    terminalsDb.updateConfig(this.db, terminalId, cfg);
  }

  /** The gated tool/question a structured AGENT thread is blocked on, or null. */
  getPendingPermission(terminalId: string): import('../structured/manager.js').PendingPermission | null {
    return this.structuredManagerForTerminal(terminalId)?.getPending(terminalId) ?? null;
  }

  /**
   * The real `claude` CLI's AskUserQuestion tool result mapper looks up each answer by
   * the question's `question` TEXT (`answers[q.question]`), never its `header` — but
   * formatAgentQuestion / answer_agent's coordinator-facing contract documents answering
   * by header (for readability in the notice), and agency-mcp.ts's bare-`answer` shortcut
   * builds a header-keyed map too. Remap here, once, so every caller — however it keyed
   * its answers — lands on the question-text keys the CLI actually reads. Accepts either
   * key per question so the already-correct web path (AskQuestionCard.tsx / store.ts,
   * which already key by `q.question`) passes through unchanged.
   */
  private remapAnswersToQuestionText(questions: any[] | undefined, answers: Record<string, string>): Record<string, string> {
    const qs = Array.isArray(questions) ? questions : [];
    const remapped: Record<string, string> = {};
    for (const q of qs) {
      const key = q?.question;
      if (typeof key !== 'string' || !key) continue;
      const value = answers[key] ?? (typeof q?.header === 'string' ? answers[q.header] : undefined);
      if (value !== undefined) remapped[key] = value;
    }
    return remapped;
  }

  /**
   * Resolve a structured thread's pending gated tool. `allow` echoes the original
   * input back to the tool, folding in the original `questions` and any AskUserQuestion
   * `answers` map (remapped onto question-text keys — see remapAnswersToQuestionText);
   * `deny` sends a message. Returns false when nothing is pending.
   */
  answerPermission(
    terminalId: string,
    requestId: string,
    opts: { decision: 'allow' | 'deny'; answers?: Record<string, string>; message?: string },
  ): boolean {
    const manager = this.structuredManagerForTerminal(terminalId);
    if (!manager) return false;
    const pending = manager.getPending(terminalId);
    if (!pending) return false;
    if (opts.decision === 'allow') {
      const remappedAnswers = opts.answers ? this.remapAnswersToQuestionText(pending.questions, opts.answers) : undefined;
      const updatedInput = {
        ...(pending.input ?? {}),
        ...(pending.questions ? { questions: pending.questions } : {}),
        ...(remappedAnswers && Object.keys(remappedAnswers).length ? { answers: remappedAnswers } : {}),
      };
      return manager.answerPermission(terminalId, requestId || pending.requestId, { behavior: 'allow', updatedInput });
    }
    return manager.answerPermission(terminalId, requestId || pending.requestId, { behavior: 'deny', message: opts.message || 'Denied' });
  }

  /**
   * Set a thread's autonomy (the per-agent dial). Persists `config.autonomy` onto
   * the terminal (merged into its config JSON so resume respects it) AND flips the
   * live escalation: 'autonomous' → auto-allow (resolves any currently-pending
   * request + future ones); 'supervised' → surface gated tools as Needs again.
   * Returns false when the terminal doesn't exist.
   */
  setAutonomy(terminalId: string, mode: 'supervised' | 'autonomous'): boolean {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return false;
    let config: Record<string, any> = {};
    try { config = JSON.parse(terminal.config || '{}'); } catch { /* default {} */ }
    config.autonomy = mode;
    terminalsDb.updateConfig(this.db, terminalId, config);
    this.structuredManagerFor(terminal.type)?.setEscalate(terminalId, mode !== 'autonomous');
    return true;
  }

  /** Gracefully interrupt a structured thread's current turn (does NOT kill it). */
  interrupt(terminalId: string): boolean {
    return this.structuredManagerForTerminal(terminalId)?.interrupt(terminalId) ?? false;
  }

  /** Trigger native Claude Code compaction on a structured thread's current turn. */
  compact(terminalId: string): boolean {
    const manager = this.structuredManagerForTerminal(terminalId);
    if (!manager?.isAlive(terminalId)) return false;
    manager.compact(terminalId);
    return true;
  }

  /**
   * Switch a running AI thread between the CLI (PTY) and Pretty (structured) transports
   * WITHOUT losing its conversation: kill the current process/connection, flip
   * `config.transport`, and re-spawn RESUMING the same `external_id` in the new transport
   * (structured backfills history from the transcript/ring; PTY resumes via
   * `claude --resume` / `codex resume`). The frontend swaps ChatView↔xterm off
   * `config.transport` on the next tabs reload.
   *
   * Guards (each throws an Error carrying an HTTP `status` for the route):
   *   - the thread must be a claude-code|codex thread (409);
   *   - it must have an `external_id` — a brand-new thread has nothing to resume (409);
   *   - Pretty must be available for the harness (codex has none until Phase B) (409);
   *   - it must be idle: a busy structured thread is interrupted then switched at the
   *     turn boundary (the preferred path); a busy PTY thread (no interruptible turn) is
   *     rejected so an in-flight turn isn't lost (409).
   * A no-op (returns the row unchanged) when the thread is already in the target transport.
   */
  async switchTransport(terminalId: string, target: 'structured' | 'pty'): Promise<terminalsDb.Terminal> {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) throw transportError(404, 'Terminal not found');
    if (terminal.type !== 'claude-code' && terminal.type !== 'codex') {
      throw transportError(409, 'Transport switching is only supported for Claude Code and Codex threads');
    }
    if (!terminal.external_id) {
      throw transportError(409, 'This thread has no session yet — send a message first, then switch');
    }
    if (target === 'structured' && !this.structuredManagerFor(terminal.type)) {
      throw transportError(409, 'Pretty transport is not available for this harness yet');
    }

    let config: Record<string, any> = {};
    try { config = JSON.parse(terminal.config || '{}'); } catch { /* default {} */ }
    const current: 'structured' | 'pty' = config.transport === 'structured' ? 'structured' : 'pty';
    if (current === target) return terminalsDb.rowToTerminal(terminal); // already there — idempotent

    // Idle guard. Interrupt-then-switch a busy structured turn (preferred); reject a busy
    // PTY thread, whose in-flight turn we can't cleanly interrupt without losing work.
    if (terminal.status === 'working') {
      const live = this.structuredManagerForTerminal(terminalId);
      if (live?.isAlive(terminalId)) {
        await this.settleStructuredTurn(live, terminalId);
      } else {
        throw transportError(409, 'This thread is busy — wait for the current turn to finish, then switch');
      }
    }

    // Fully tear down the OLD transport (awaiting its exit) BEFORE re-spawning, so its async
    // exit handler can't null the pid / reset the status of the transport we're about to start.
    await this.killCurrentTransport(terminal.type, terminalId, current);

    // Merge `config.transport` via read-merge-write — NEVER clobber unrelated keys
    // (model, role, pinned, autoArchive, …), exactly like setAutoArchive.
    const fresh = terminalsDb.getById(this.db, terminalId);
    let merged: Record<string, any> = {};
    try { merged = JSON.parse(fresh?.config || '{}'); } catch { /* default {} */ }
    if (target === 'structured') merged.transport = 'structured';
    else delete merged.transport;
    terminalsDb.updateConfig(this.db, terminalId, merged);
    terminalsDb.updatePid(this.db, terminalId, null);

    // Re-spawn: spawnTerminal reads the freshly-merged config and dispatches to the right
    // transport, resuming `external_id` (structured `-r`/backfill or PTY resume) either way.
    this.spawnTerminal(terminalId);

    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, terminalId)!);
  }

  /**
   * Interrupt a live structured turn and wait for the turn boundary ('idle') or the
   * process exit — bounded, so a wedged CLI can't hang the switch forever.
   */
  private async settleStructuredTurn(
    manager: import('../structured/manager.js').IStructuredManager,
    terminalId: string,
    timeoutMs = 5000,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        manager.off('idle', onSettle);
        manager.off('exit', onSettle);
        resolve();
      };
      const onSettle = (id: string) => { if (id === terminalId) finish(); };
      manager.on('idle', onSettle);
      manager.on('exit', onSettle);
      manager.interrupt(terminalId);
      timer = setTimeout(finish, timeoutMs);
    });
  }

  /**
   * Kill whichever transport currently backs a thread and wait for it to fully exit
   * (bounded), mirroring restartTerminal's await-exit-before-respawn discipline.
   */
  private async killCurrentTransport(type: string, terminalId: string, current: 'structured' | 'pty'): Promise<void> {
    if (current === 'pty') {
      if (!this.ptyManager.isAlive(terminalId)) { this.ptyManager.kill(terminalId); return; }
      await this.awaitExit((cb) => this.ptyManager.on('exit', cb), (cb) => this.ptyManager.off('exit', cb), () => this.ptyManager.kill(terminalId), terminalId);
    } else {
      const manager = this.structuredManagerFor(type);
      if (!manager?.isAlive(terminalId)) { manager?.kill(terminalId); return; }
      await this.awaitExit((cb) => manager.on('exit', cb), (cb) => manager.off('exit', cb), () => manager.kill(terminalId), terminalId);
    }
  }

  /** Shared kill-then-await-'exit'(terminalId) helper, bounded so a stuck process can't hang. */
  private async awaitExit(
    on: (cb: (id: string) => void) => void,
    off: (cb: (id: string) => void) => void,
    kill: () => void,
    terminalId: string,
    timeoutMs = 3000,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => { if (done) return; done = true; if (timer) clearTimeout(timer); off(onExit); resolve(); };
      const onExit = (id: string) => { if (id === terminalId) finish(); };
      on(onExit);
      kill();
      timer = setTimeout(finish, timeoutMs);
    });
  }

  /**
   * Find-or-create the project's Overseer coordinator: a structured claude-code
   * thread tagged `config.role === 'coordinator'`. Returns the existing one if a
   * non-archived coordinator already exists, else spawns a new one labelled
   * "Overseer" via the normal createTerminal path. Idempotent (one per project).
   */
  ensureCoordinator(sessionId: string): terminalsDb.Terminal {
    const session = sessionsDb.getById(this.db, sessionId);
    if (!session) throw new Error('Session not found');

    const existing = terminalsDb.listBySession(this.db, sessionId)
      .map(terminalsDb.rowToTerminal)
      .find((t) => t.type === 'claude-code' && t.config?.role === 'coordinator');
    if (existing) {
      // A coordinator record can outlive its process (daemon restart). Revive it so
      // the caller gets a LIVE coordinator (resume if a session was captured, else fresh)
      // instead of a dead one that silently swallows directives.
      this.ensureStructuredAlive(existing.id);
      return existing;
    }

    return this.createTerminal(
      sessionId,
      'claude-code',
      'Overseer',
      undefined,
      undefined,
      undefined,
      { transport: 'structured', role: 'coordinator' },
    );
  }

  writeToTerminal(terminalId: string, data: string): void {
    this.ptyManager.write(terminalId, data);
  }

  resolveTerminalFilePath(terminalId: string, requestedPath: string): string | null {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return null;

    const session = sessionsDb.getById(this.db, terminal.session_id);
    if (!session) return null;

    const sessionRoot = path.resolve(session.working_dir);
    const terminalRoot = path.resolve(terminal.working_dir || session.working_dir);
    const roots = Array.from(new Set([terminalRoot, sessionRoot]));

    if (path.isAbsolute(requestedPath)) {
      const resolved = path.resolve(requestedPath);
      if (roots.some(root => this.isPathInside(root, resolved))) return resolved;
      throw new Error('Path traversal not allowed');
    }

    const sessionResolved = path.resolve(sessionRoot, requestedPath);
    if (!this.isPathInside(sessionRoot, sessionResolved)) {
      throw new Error('Path traversal not allowed');
    }

    if (requestedPath === '.dispatch/inbox' || requestedPath.startsWith('.dispatch/inbox/')) {
      return sessionResolved;
    }

    if (this.pathExists(sessionResolved)) {
      return sessionResolved;
    }

    const terminalResolved = path.resolve(terminalRoot, requestedPath);
    if (!this.isPathInside(terminalRoot, terminalResolved)) {
      throw new Error('Path traversal not allowed');
    }
    return terminalResolved;
  }

  private pathExists(resolvedPath: string): boolean {
    try {
      return fs.existsSync(resolvedPath);
    } catch {
      return false;
    }
  }

  sendFileReference(terminalId: string, requestedPath: string, mode: 'agent-context' | 'shell-path' = 'agent-context'): { sentText: string } | null {
    const absolutePath = this.resolveTerminalFilePath(terminalId, requestedPath);
    if (!absolutePath) return null;
    if (!this.ptyManager.isAlive(terminalId)) throw new Error('Terminal process is not running');

    const sentText = mode === 'shell-path'
      ? `${this.shellEscapePath(absolutePath)} `
      : `Use this file as context: ${absolutePath}\r`;
    this.ptyManager.write(terminalId, sentText);
    return { sentText };
  }

  stopAllTerminals(): void {
    this.ptyManager.killAll();
  }

  renameTerminal(terminalId: string, label: string): terminalsDb.Terminal | null {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return null;
    terminalsDb.updateLabel(this.db, terminalId, label);
    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, terminalId)!);
  }

  removeTerminal(terminalId: string): void {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return;
    // Only kill PTY for terminal types that have processes
    if (terminalsDb.isPtyType(terminal.type)) {
      if (this.ptyManager.isAlive(terminalId)) this.ptyManager.kill(terminalId);
      this.structuredManagerFor(terminal.type)?.kill(terminalId);
    }
    // Soft-delete: archive instead of remove
    terminalsDb.archive(this.db, terminalId);
    // thread_watches has no FK to terminals (rows outlive a deleted watcher/target by
    // design — see db/watches.ts), so this is the daemon's one "a thread is gone" hook:
    // sweep any watch where this terminal was either side, else rows accumulate forever.
    watchesDb.removeForTerminal(this.db, terminalId);
  }

  // Restore an archived terminal
  restoreTerminal(terminalId: string): terminalsDb.Terminal | null {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return null;
    terminalsDb.unarchive(this.db, terminalId);
    // Re-spawn if it's a PTY type
    if (terminalsDb.isPtyType(terminal.type)) {
      try {
        this.spawnTerminal(terminalId);
      } catch {
        terminalsDb.updatePid(this.db, terminalId, null);
        terminalsDb.updateStatus(this.db, terminalId, 'error');
      }
    }
    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, terminalId)!);
  }

  listArchivedTerminals(sessionId: string): terminalsDb.Terminal[] {
    return terminalsDb.listArchivedBySession(this.db, sessionId).map(terminalsDb.rowToTerminal);
  }

  private spawnTerminal(terminalId: string): void {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) throw new Error('Terminal not found');

    const session = sessionsDb.getById(this.db, terminal.session_id);
    if (!session) throw new Error('Session not found');

    const workDir = terminal.working_dir || session.working_dir;

    // Runner terminals (agent runs) persist their prompt in config and always
    // launch the headless autonomous command — never resume/interactive.
    let config: Record<string, any> = {};
    try { config = JSON.parse(terminal.config || '{}'); } catch { /* default {} */ }
    const runnerPrompt: string | undefined =
      config.runner && typeof config.runnerPrompt === 'string' ? config.runnerPrompt : undefined;

    let command: string;
    let args: string[];

    if (terminal.type === 'shell') {
      const shell = platform.defaultShell();
      command = shell.command;
      args = shell.args;
    } else {
      const provider = getProvider(terminal.type);
      const specs: McpServerSpec[] = [];
      const prompts: string[] = [];
      const sec = this.secretsServerSpec?.();
      if (sec?.spec) { specs.push(sec.spec); if (sec.prompt) prompts.push(sec.prompt); }
      const intgSpecs = this.integrationsSpecs?.() ?? [];
      specs.push(...intgSpecs);
      if (config.role === 'coordinator') {
        specs.push(this.agencyServerSpec(terminalId, terminal.session_id, typeof config.spawnDepth === 'number' ? config.spawnDepth : 0));
        prompts.push(this.peerPromptFor(terminal));
      }
      const developerNote = this.toolsAwareness?.() ?? null;
      const secretsMcp = composeInjection(specs, { configPath: this.perTerminalMcpConfigPath(terminalId), prompts, developerNote });
      if (config.transport === 'structured' && this.structuredManagerFor(terminal.type)) {
        // Spawn (or, when an external_id is already known, RESUME) the structured
        // thread via the right manager for this harness (claude stream-json / codex
        // app-server). spawnStructured re-applies the full role/escalate/MCP wiring
        // and backfills prior history on resume.
        this.spawnStructured(terminal, config, workDir);
        return; // structured path complete — skip PTY spawn + session-id capture
      }
      let cmd: { command: string; args: string[] };
      if (runnerPrompt !== undefined) {
        // Runner launches emit their own structured stream-json; no hooks needed.
        cmd = provider.buildRunnerCommand({ workDir, prompt: runnerPrompt, secretsMcp });
      } else {
        const statusHooks = this.buildStatusHooks(terminalId, terminal.type);
        const branchFrom: string | undefined = typeof config.branchFrom === 'string' ? config.branchFrom : undefined;
        // Honor a per-thread model pick (config.model) for CLI (PTY) threads too, not
        // just structured ones — the New Thread modal offers the picker in both modes.
        // modelFor returns config.model for a plain user thread (no role/agentType).
        const model = modelFor(config);
        cmd = terminal.external_id
          ? provider.buildResumeCommand({ externalSessionId: terminal.external_id, workDir, secretsMcp, statusHooks, model })
          : (branchFrom && provider.buildBranchCommand)
            ? provider.buildBranchCommand({ sourceSessionId: branchFrom, workDir, secretsMcp, statusHooks })
            : provider.buildNewCommand({ workDir, secretsMcp, statusHooks, model });
      }
      command = cmd.command;
      args = cmd.args;
    }

    const pid = this.ptyManager.spawn(terminalId, command, args, workDir, { [TERMINAL_ID_ENV_VAR]: terminalId });
    terminalsDb.updatePid(this.db, terminalId, pid);

    // If this was a fresh spawn (no external_id yet), let the provider try to
    // discover the session id it assigned — so a later relaunch can resume.
    if (terminal.type !== 'shell' && !terminal.external_id) {
      void this.captureExternalSessionId(terminalId, terminal.type, workDir);
    }
  }

  /**
   * Spawn — or, when a claude session id is already known, RESUME — a structured
   * stream-json thread, re-applying the SAME role / escalate / MCP wiring as the
   * original spawn:
   *   - coordinators get the Dispatch agency MCP folded in (autonomous spawn/steer),
   *   - the Overseer persona is injected via --append-system-prompt,
   *   - only typed AGENT threads escalate gated tools (the membrane).
   * When `terminal.external_id` is set it appends `-r <id>` (resume the same claude
   * conversation) and backfills the ring with prior history so the View isn't blank
   * after a daemon restart. Idempotent: a no-op when the thread is already alive.
   */
  private spawnStructured(terminal: terminalsDb.TerminalRow, config: Record<string, any>, workDir: string): void {
    const manager = this.structuredManagerFor(terminal.type);
    if (!manager) throw new Error('structured transport not supported for this provider');
    if (manager.isAlive(terminal.id)) return; // already running — don't double-spawn

    const provider = getProvider(terminal.type);
    // Same secrets/integrations/tools-awareness MCP wiring as a fresh PTY spawn.
    const specs: McpServerSpec[] = [];
    const prompts: string[] = [];
    const sec = this.secretsServerSpec?.();
    if (sec?.spec) { specs.push(sec.spec); if (sec.prompt) prompts.push(sec.prompt); }
    const intgSpecs = this.integrationsSpecs?.() ?? [];
    specs.push(...intgSpecs);
    if (config.role === 'coordinator') {
      specs.push(this.agencyServerSpec(terminal.id, terminal.session_id, typeof config.spawnDepth === 'number' ? config.spawnDepth : 0));
      prompts.push(this.peerPromptFor(terminal));
    }
    const developerNote = this.toolsAwareness?.() ?? null;
    const structuredMcp = composeInjection(specs, { configPath: this.perTerminalMcpConfigPath(terminal.id), prompts, developerNote });

    const resumeSessionId = terminal.external_id || undefined;

    // Resolve the model up front and persist it into the terminal's config if it
    // wasn't already pinned there — so it survives a daemon-restart resume and is
    // returned to the frontend as part of the terminal row's config.
    const resolvedModel = modelFor(config);
    if (resolvedModel && !config.model) {
      config.model = resolvedModel;
      terminalsDb.updateConfig(this.db, terminal.id, config);
    }

    let sc: { command: string; args: string[] };
    if (this.structuredCommandOverride) {
      // Test seam: spawn the fake instead of real claude. Still surface `-r <id>` on
      // resume so the resume path is observable in tests.
      sc = { command: this.structuredCommandOverride.command, args: [...this.structuredCommandOverride.args] };
      if (resumeSessionId) sc.args.push('-r', resumeSessionId);
    } else {
      const built = provider.buildStructuredCommand?.({ workDir, secretsMcp: structuredMcp, appendSystemPrompt: systemPromptFor(config), resumeSessionId, model: resolvedModel });
      if (!built) throw new Error('structured transport not supported for this provider');
      sc = built;
    }

    // On resume, restore prior conversation from the claude transcript JSONL. Claude-only:
    // the Codex manager has no Claude transcript to read — it backfills its own history from
    // `thread/resume`/`thread/read` (see CodexStructuredSessionManager.backfill).
    const rawSeedEvents = resumeSessionId && terminal.type === 'claude-code' ? readSessionBackfill(workDir, resumeSessionId) : undefined;
    // Merge back any durably-stored `source` tags (see db/message-source.ts) — the
    // transcript itself carries none, so a revived thread would otherwise lose the "via
    // Dispatch" badge on every turn sent before the CLI process last exited.
    const seedEvents = rawSeedEvents?.length
      ? applyDurableSources(
          rawSeedEvents,
          messageSourceDb.getForUuids(this.db, terminal.id, rawSeedEvents.map((e) => (e as any)?.uuid).filter((u): u is string => typeof u === 'string')),
        )
      : rawSeedEvents;

    // Autonomy dial: agents run AUTONOMOUSLY by default — they auto-allow every tool and
    // never prompt the human; the only thing that pauses an agent is an AskUserQuestion,
    // which the manager always surfaces and the service routes UP to the coordinator. Only
    // an explicit config.autonomy === 'supervised' re-arms the per-tool membrane (rare opt-in,
    // surfaces plain gated tools to the human). Persisted in config.autonomy so it survives a
    // resume after a daemon restart.
    const escalate = config.role === 'agent' && config.autonomy === 'supervised';

    const pid = manager.spawn(terminal.id, {
      command: sc.command,
      args: sc.args,
      workDir,
      escalate,
      seedEvents,
      // Codex resumes/pins-model out-of-band over JSON-RPC (Claude encodes both in `args` and
      // ignores these); shared on the interface so this one call drives either manager.
      resumeId: resumeSessionId,
      model: resolvedModel,
      env: { [TERMINAL_ID_ENV_VAR]: terminal.id },
    });
    terminalsDb.updatePid(this.db, terminal.id, pid);
  }

  /**
   * Lazily revive a structured thread on demand (its ws connects or it receives a
   * message) after a daemon restart: if it's not alive but is a non-archived
   * structured claude-code thread, re-spawn it — resuming the same claude
   * conversation when an external_id was captured, else spawning fresh. Idempotent —
   * returns true if alive (or already was), false only for non-structured/archived
   * threads. Never throws.
   */
  ensureStructuredAlive(terminalId: string): boolean {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal || terminal.archived_at) return false;
    const manager = this.structuredManagerFor(terminal.type);
    if (!manager) return false; // no structured transport for this harness (e.g. codex until Phase B)
    if (manager.isAlive(terminalId)) return true;
    let config: Record<string, any> = {};
    try { config = JSON.parse(terminal.config || '{}'); } catch { /* default {} */ }
    if (config.transport !== 'structured') return false;
    // A queued row is deliberately parked (created-but-not-spawned): never let a
    // ws-connect (drill-in) or stray message auto-spawn it. Only the explicit
    // startQueuedTerminal promote path (which strips this flag first) may spawn it.
    if (config.queued === true) return false;
    // No external_id ⇒ spawn FRESH. A structured thread that never captured a claude
    // session id (created-but-not-yet-run, or a coordinator whose process the restart
    // killed before init) must still come back to life rather than silently swallow
    // messages. With an external_id, spawnStructured resumes the same conversation.
    const session = sessionsDb.getById(this.db, terminal.session_id);
    if (!session) return false;
    const workDir = terminal.working_dir || session.working_dir;
    try {
      this.spawnStructured(terminal, config, workDir);
      return manager.isAlive(terminalId);
    } catch {
      return false;
    }
  }

  /**
   * One-shot boot recovery: auto-resume overseer threads (the coordinator and its
   * typed agents) that the last daemon shutdown interrupted mid-turn. The signal is
   * free — a non-archived structured terminal still in `status='working'` at boot
   * died mid-turn (clean shutdown skips the settle-to-`waiting` write, and
   * clearStalePids only touches sessions). Kicking is a single sendStructuredMessage:
   * it revives the thread (spawn/`-r` + transcript backfill) AND re-prompts it to
   * continue.
   *
   * Idempotency (so a restart-during-recovery doesn't double-prompt or make a
   * finished agent redo work):
   *   - skip a thread whose transcript tail shows a COMPLETED turn — the shutdown
   *     race left it stale-`working` but it actually finished;
   *   - skip a thread already stamped `config.kickedAt` with no newer transcript
   *     activity since (we kicked it on a prior boot and it hasn't moved).
   * Each kicked thread is stamped `config.kickedAt` afterwards.
   *
   * DEFERRED (follow-up): `needs_input` agents lose their in-memory pending on
   * restart. They aren't `working`, so this kicker correctly skips them — reviving
   * them needs a different path (re-surface the question), not a mid-task nudge.
   */
  async kickstartInterruptedAgents(settleMs: number = KICKSTART_SETTLE_MS): Promise<{ kicked: string[]; skipped: string[] }> {
    const kicked: string[] = [];
    const skipped: string[] = [];
    if (!this.structuredManager) return { kicked, skipped };

    // (a) Settle: let any burst of save writes from the shutdown coalesce before we read status.
    if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));

    // (b) Enumerate every non-archived claude-code terminal left `working` across all sessions.
    const rows = terminalsDb.listWorkingStructured(this.db);
    for (const row of rows) {
      let config: Record<string, any> = {};
      try { config = JSON.parse(row.config || '{}'); } catch { skipped.push(row.id); continue; }
      // Structured overseer threads only: the coordinator and its typed agents.
      if (config.transport !== 'structured') { skipped.push(row.id); continue; }
      if (config.role !== 'coordinator' && config.role !== 'agent') { skipped.push(row.id); continue; }

      // (c) Idempotency. Compare against the transcript, which advances as the thread works.
      const session = sessionsDb.getById(this.db, row.session_id);
      const workDir = row.working_dir || session?.working_dir || null;
      const tail = (workDir && row.external_id) ? transcriptTailStatus(workDir, row.external_id) : null;

      // Already kicked on a prior boot and nothing new happened since → don't re-prompt.
      const kickedAt = typeof config.kickedAt === 'string' ? Date.parse(config.kickedAt) : NaN;
      if (!Number.isNaN(kickedAt) && (!tail || tail.mtimeMs <= kickedAt)) { skipped.push(row.id); continue; }

      // The turn actually completed (shutdown race left it stale-working) → nothing to resume.
      if (tail?.completed) { skipped.push(row.id); continue; }

      // (d) Kick (revive + re-prompt) and stamp so a later restart won't double-kick.
      try {
        this.sendStructuredMessage(row.id, KICKSTART_CONTINUE_PROMPT);
        config.kickedAt = new Date().toISOString();
        terminalsDb.updateConfig(this.db, row.id, config);
        kicked.push(row.id);
      } catch {
        skipped.push(row.id);
      }
    }
    return { kicked, skipped };
  }

  /**
   * Per-terminal MCP config path: `thread-<terminalId>.mcp.json`, sitting beside the
   * (otherwise-unused-as-a-file) `this.mcpConfigPath` daemon dir. Every spawn — coordinator
   * or not — gets its own file. This is NOT the old per-coordinator special case: it's
   * uniform for all terminal types, because the same clobber risk exists for ANY per-thread
   * content, not just the agency server.
   *
   * Why this exists: `composeInjection` writes synchronously at spawn time, but Claude
   * only reads the file at ITS OWN process startup, well after `spawn()` returns. If every
   * terminal shared one daemon-wide path, terminal B's spawn (in a different session,
   * spawned moments later) would overwrite the exact file terminal A's not-yet-started
   * child was about to read — handing A's child B's `DISPATCH_SESSION`/`DISPATCH_TERMINAL`
   * (a project-scope violation) or silently dropping the `dispatch` server. A per-terminal
   * path makes that race structurally impossible: no two terminals ever write the same file.
   */
  private perTerminalMcpConfigPath(terminalId: string): string {
    return path.join(path.dirname(this.mcpConfigPath), `thread-${terminalId}.mcp.json`);
  }

  /**
   * The Dispatch "agency" MCP server spec for a coordinator thread: points at the
   * compiled agency-mcp.js and carries the caller's identity — DISPATCH_SESSION (this
   * project, so threads the coordinator spawns land in the same project) and
   * DISPATCH_TERMINAL (which thread is calling — consumed by the peer-thread tools
   * for self-identification) and DISPATCH_SPAWN_DEPTH (this thread's own spawn-chain
   * depth, so spawn_agent/queue_agent can enforce MAX_SPAWN_DEPTH and stamp the right
   * depth on any child, without an extra round-trip to the daemon). Pushed into the
   * `specs` array handed to composeInjection ALONGSIDE the Doppler/integrations specs
   * — no more bespoke config-file post-processing — so composeInjection's single spec
   * list produces both the Claude --mcp-config JSON and codex's `-c mcp_servers.*`
   * args, and codex coordinators get the server too, not just claude-code ones. The
   * resulting config is written to a PER-TERMINAL path (see `perTerminalMcpConfigPath`),
   * never the shared daemon-wide one.
   */
  private agencyServerSpec(terminalId: string, sessionId: string, spawnDepth: number): McpServerSpec {
    const agencyPath = fileURLToPath(new URL('../overseer/agency-mcp.js', import.meta.url));
    return {
      name: 'dispatch',
      command: 'node',
      args: [agencyPath],
      env: {
        DISPATCH_SESSION: sessionId,
        DISPATCH_PORT: String(process.env.PORT || 3456),
        DISPATCH_TERMINAL: terminalId,
        DISPATCH_SPAWN_DEPTH: String(spawnDepth),
      },
    };
  }

  /**
   * Build the peer-context system-prompt block for one thread: its project's name
   * and working dir, its own label + id, and a roster snapshot of its live (non-
   * archived) project peers — every OTHER terminal in the same session, self
   * excluded. Callers push the result into the `prompts` array fed to
   * composeInjection under the SAME gate as agencyServerSpec (today: coordinators
   * only — see the call sites in spawnTerminal/spawnStructured; Task 8 widens both
   * gates together, in one flip).
   */
  private peerPromptFor(terminal: terminalsDb.TerminalRow): string {
    const session = sessionsDb.getById(this.db, terminal.session_id);
    const workingDir = terminal.working_dir || session?.working_dir || '';
    const peers = terminalsDb.listBySession(this.db, terminal.session_id)
      .filter((t) => t.id !== terminal.id)
      .map((t) => ({ label: t.label, type: t.type, status: t.status }));
    return buildPeerPrompt({
      projectName: session?.name || terminal.session_id,
      workingDir,
      selfLabel: terminal.label,
      selfId: terminal.id,
      peers,
    });
  }

  private async captureExternalSessionId(terminalId: string, type: string, workDir: string): Promise<void> {
    const provider = getProvider(type);
    if (!provider.captureSessionId) return;
    const spawnTime = Date.now();
    try {
      const sid = await provider.captureSessionId({ workDir, spawnTime, deadlineMs: 30_000 });
      if (!sid) return;
      const current = terminalsDb.getById(this.db, terminalId);
      if (!current || current.external_id) return;
      terminalsDb.updateExternalId(this.db, terminalId, sid);
    } catch {
      // Best-effort; relaunch will simply start a fresh session if we miss it.
    }
  }

  private isPathInside(root: string, target: string): boolean {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }

  private shellEscapePath(absolutePath: string): string {
    return `'${absolutePath.replace(/'/g, `'\\''`)}'`;
  }

  private defaultTerminalLabel(sessionId: string, type: TerminalType): string {
    const terminals = terminalsDb.listBySession(this.db, sessionId);
    const sameType = terminals.filter(t => t.type === type);

    switch (type) {
      case 'claude-code': return sameType.length > 0 ? `Claude Code #${sameType.length + 1}` : 'Claude Code';
      case 'codex': return sameType.length > 0 ? `Codex #${sameType.length + 1}` : 'Codex';
      case 'shell': return sameType.length > 0 ? `Terminal #${sameType.length + 1}` : 'Terminal';
    }
  }

  private autoName(workDir: string): string {
    const folder = workDir.split('/').pop() || 'session';
    const existing = sessionsDb.list(this.db).filter(s => s.name.startsWith(folder));
    return existing.length > 0 ? `${folder} #${existing.length + 1}` : folder;
  }

}

/** A short single-line snippet centered on a match, with ellipses + collapsed whitespace. */
function snippetAround(text: string, at: number, matchLen: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  // Recompute the match position in the collapsed string (approximate is fine).
  const idx = flat.toLowerCase().indexOf(text.slice(at, at + matchLen).replace(/\s+/g, ' ').trim().toLowerCase());
  const start = Math.max(0, (idx < 0 ? 0 : idx) - 30);
  const end = Math.min(flat.length, (idx < 0 ? 0 : idx) + matchLen + 50);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}
