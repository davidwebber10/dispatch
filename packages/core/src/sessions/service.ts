import { expandHome, hostedProjectDir } from './project-dir.js';
import { isHostedBox } from '../os/hosted-mode.js';
import { StatusService } from '../status/service.js';
import type { UsageLimitService } from '../limits/service.js';
import type { PromptSource } from '../plugins/thread-events.js';
import { PromptInput } from './prompt-input.js';
import { ThreadTranscripts } from './thread-transcripts.js';
import { CoordinatorNotifier } from './coordinator-notifier.js';
import { SpawnInjection } from './spawn-injection.js';
import { ThreadSpawner } from './thread-spawner.js';
import { BootRecovery } from './boot-recovery.js';
import { ThreadQuestions } from './thread-questions.js';
import { HarnessRegistry } from './harness-registry.js';
import { ThreadFiles } from './thread-files.js';
import { ThreadMessages } from './thread-messages.js';
import { emptySessionWiring, type SessionWiring, type StatusContext } from './session-wiring.js';
import { ThreadSettings } from './thread-settings-service.js';
import { redactKeysDeep } from '../auth/redact-keys.js';
import { clientMessage } from '../http/client-message.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import * as agentsDb from '../db/agents.js';
import * as appState from '../db/app-state.js';
import * as watchesDb from '../db/watches.js';
import * as coordinatorMessagesDb from '../db/coordinator-messages.js';
import { computeBatchState, type BatchOptions, type BatchState } from './batch-state.js';
import { type QuestionCannedAction } from './question-reply.js';
import { LedgerService } from '../overseer/ledger-service.js';
import { getProvider } from '../providers/registry.js';
import { PTYManager } from '../pty/manager.js';
import type { Session, CreateSessionInput } from '../types.js';
import { rowToSession } from '../types.js';
import type { TerminalType } from '../db/terminals.js';
import type { KeyHandle, KeyRegistry } from '../auth/principals.js';
import { ThreadKeys } from './thread-keys.js';

import { type McpServerSpec } from '../mcp/injection.js';
import { type ConvItem } from '../conversation/transcript.js';
import { type ConvPage, type ConvPageOptions, type SearchMatch } from '../conversation/reader.js';
import { resumeAdvice as readResumeAdvice, type ResumeAdvice } from './cc-sessions.js';
import { DeliveryOutbox, type DeliverResult, type OutboxKind } from '../delivery/outbox.js';
import { isAgentType, type AgentType } from '../providers/agent-types.js';
import { findLiveCoordinator } from '../auth/key-scope.js';
import { DEFAULT_AUTO_ARCHIVE_MS } from './auto-archive.js';
import { ThreadConfigStore, pickClientSettable } from './thread-config.js';

export { disallowedToolsFor, type SpawnKey } from './thread-spawner.js';

export { pickRecoverableSession } from './thread-transcripts.js';

/**
 * A new root thread (no parent, no depth) is written with `spawnDepth: 0`, so the field is
 * never missing on a new record (spec 6.1). A thread with a parent or its own depth is kept.
 */
function withRootSpawnDepth(config: Record<string, any> | undefined): Record<string, any> {
  const c = config ?? {};
  if (c.spawnedBy || typeof c.spawnDepth === 'number') return c;
  return { ...c, spawnDepth: 0 };
}

/**
 * A folder in a worktree of a project (`<project>/.claude/worktrees/<name>` or
 * `<project>/.worktrees/<name>`, or a folder below one). A thread that runs there does not set the
 * last folder: that is the default folder of the new-project picker, and a worktree is not a project.
 */
function isWorktreeFolder(dir: string): boolean {
  return /(^|\/)(\.claude\/worktrees|\.worktrees)\/[^/]+(\/|$)/.test(dir.replace(/\\/g, '/'));
}

export class SessionService {
  /** How spawned CLIs phone home with lifecycle events; set by the server wiring. */
  private terminalStatusWriter?: (id: string, status: 'queued' | 'waiting' | 'error') => void;
  setTerminalStatusWriter(writer: (id: string, status: 'queued' | 'waiting' | 'error') => void): void { this.terminalStatusWriter = writer; }
  private setTerminalStatus(id: string, status: 'queued' | 'waiting' | 'error'): void {
    if (this.terminalStatusWriter) this.terminalStatusWriter(id, status);
    else StatusService.detached(this.db).setTerminalState(id, status); // isolated service/test compatibility; StatusService is the one writer (W3-C)
  }
  /** The thread an auto-resume is being sent to: that send is not the owner taking over. */
  private resuming: string | null = null;
  setUsageLimitService(svc: UsageLimitService): void { this.wiring.usageLimits = svc; }
  /** Send the usage-limit auto-resume text. Unlike every other send it keeps the park's attempt count. */
  resumeAfterUsageLimit(terminalId: string, text: string): 'pty' | 'structured' {
    this.resuming = terminalId;
    try {
      const sent = this.sendThreadMessage(terminalId, text, undefined, 'daemon');
      this.noteUserPrompt(terminalId, text, 'daemon');
      // A structured send flips to working off its own stream events; a PTY write has no such signal,
      // so mark the thread working here, as the HTTP message route does. Without the working edge the
      // turn end is not a settle, and the woken pause row would never clear.
      if (sent.transport === 'pty') this.wakeWorkingMarker?.(terminalId);
      return sent.transport;
    } finally { this.resuming = null; }
  }
  private wakeWorkingMarker?: (terminalId: string) => void;
  /** How a daemon wake into a CLI (PTY) thread marks it working; set by the server wiring. */
  setWakeWorkingMarker(fn: (terminalId: string) => void): void { this.wakeWorkingMarker = fn; }
  /** Anyone else sending to a thread, or the owner typing in it, ends its pause. */
  private noteThreadTouched(terminalId: string, source?: string, logAs?: string): void {
    // Only the owner's own message (tagged source 'user') takes over; notices, recaps, watches and
    // coordinator sends leave the pause alone.
    if (this.resuming !== terminalId && source === 'user') this.wiring.usageLimits?.onUserMessage(terminalId);
  }
  private onUserPrompt?: (terminalId: string, text: string, source: PromptSource) => void;
  private promptInputs = new Map<string, PromptInput>();
  setUserPromptListener(listener: (terminalId: string, text: string, source: PromptSource) => void): void { this.onUserPrompt = listener; }
  /** A prompt went to a thread: the owner's, or one a peer, the Control Plane or the daemon sent (plugins hear the source). */
  noteUserPrompt(terminalId: string, content: string | import('../structured/manager.js').ContentBlock[], source: PromptSource = 'user'): void {
    const text = typeof content === 'string' ? content : content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n');
    try { this.onUserPrompt?.(terminalId, text, source); } catch { /* naming must never prevent sending */ }
  }
  noteUserInput(terminalId: string, data: string): void {
    // Typing counts; a bare focus-in/out report from the terminal does not.
    if (/[\x20-\x7e\r]/.test(data.replace(/\x1b\[[IO]/g, ''))) this.wiring.usageLimits?.onUserMessage(terminalId);
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal || terminal.label_source !== 'default' || !isAgentType(terminal.type)) { this.promptInputs.delete(terminalId); return; }
    const input = this.promptInputs.get(terminalId) ?? new PromptInput();
    this.promptInputs.set(terminalId, input);
    for (const prompt of input.feed(data)) this.noteUserPrompt(terminalId, prompt);
  }
  setAccountEnv(fn: (type: string, config: Record<string, unknown>) => Record<string, string>): void { this.wiring.accountEnv = fn; }
  setAccountDirectory(d: { has: (type: string, accountId: string) => boolean; defaultId: (type: string) => string }): void { this.wiring.accountDirectory = d; }
  /** The service's clock. Tests replace it to pin times (message log, interim recap timer). */
  clock: () => number = () => Date.now();
  /** The structured manager of each harness and their events (sessions/harness-registry.ts). */
  private readonly harnesses: HarnessRegistry;
  setOverseerMemoryHome(home: string): void { this.wiring.overseerMemoryHome = home; }

  /** What the daemon hands over after the service is built (sessions/session-wiring.ts). The parts read it at each use. */
  private readonly wiring: SessionWiring = emptySessionWiring();

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
    opts: { configStore?: ThreadConfigStore } = {},
  ) {
    this.configStore = opts.configStore ?? new ThreadConfigStore(db);
    this.transcripts = new ThreadTranscripts(db);
    this.harnesses = new HarnessRegistry({
      db, configStore: this.configStore, wiring: this.wiring,
      threads: { undoRefusedPick: (id, info) => this.undoRefusedPick(id, info) },
    });
    // The parts call back through `this`, so a caller that replaces a facade method still reaches every path.
    this.notifier = new CoordinatorNotifier({
      db, configStore: this.configStore, pty: ptyManager, transcripts: this.transcripts,
      clock: () => this.clock(),
      outbox: () => this.deliveryOutbox,
      ledger: () => this.ledger,
      threads: {
        structuredManagerForTerminal: (id) => this.structuredManagerForTerminal(id),
        isStructuredTerminal: (row) => this.isStructuredTerminal(row),
        ensureStructuredAlive: (id) => this.ensureStructuredAlive(id),
        sendStructuredMessage: (id, content) => this.sendStructuredMessage(id, content),
        startQueuedTerminal: (id, task, o) => this.startQueuedTerminal(id, task, o),
        getPendingPermission: (id) => this.getPendingPermission(id),
        batchState: (sessionId, o) => this.batchState(sessionId, o),
      },
    });
    this.settings = new ThreadSettings({
      db, configStore: this.configStore, pty: ptyManager,
      accountDirectory: () => this.wiring.accountDirectory,
      onTerminalChanged: (sessionId) => this.onTerminalChanged?.(sessionId),
      threads: {
        structuredManagerFor: (type) => this.structuredManagerFor(type),
        structuredManagerForTerminal: (id) => this.structuredManagerForTerminal(id),
        isStructuredTerminal: (row) => this.isStructuredTerminal(row),
        spawnTerminal: (id) => this.spawnTerminal(id),
        revokeAllKeys: (id) => this.revokeAllKeys(id),
      },
    });
    this.injection = new SpawnInjection({ db, configStore: this.configStore, wiring: this.wiring, mcpConfigPath });
    this.spawner = new ThreadSpawner({
      db, configStore: this.configStore, pty: ptyManager, wiring: this.wiring, injection: this.injection,
      threads: {
        structuredManagerFor: (type) => this.structuredManagerFor(type),
        codexEffortFor: (config, model) => this.codexEffortFor(config, model),
      },
    });
    this.questions = new ThreadQuestions({
      threads: {
        structuredManagerForTerminal: (id) => this.structuredManagerForTerminal(id),
        restoredQuestions: () => this.restoredQuestions,
        logCoordinatorMessage: (id, content, source) => this.logCoordinatorMessage(id, content, source),
        noteQuestionAnsweredInChat: (id, reply, imageCount, canned) => this.noteQuestionAnsweredInChat(id, reply, imageCount, canned),
      },
    });
    this.files = new ThreadFiles({ db, pty: ptyManager });
    this.messages = new ThreadMessages({
      db, pty: ptyManager, clock: () => this.clock(), spawner: this.spawner,
      threads: {
        structuredManagerForTerminal: (id) => this.structuredManagerForTerminal(id),
        ensureStructuredAlive: (id) => this.ensureStructuredAlive(id),
        isStructuredTerminal: (row) => this.isStructuredTerminal(row),
        sendStructuredMessage: (id, content, source, logAs) => this.sendStructuredMessage(id, content, source, logAs),
        noteThreadTouched: (id, source, logAs) => this.noteThreadTouched(id, source, logAs),
      },
    });
    this.bootRecovery = new BootRecovery({
      db, configStore: this.configStore,
      threads: {
        structuredManagerFor: (type) => this.structuredManagerFor(type),
        sendStructuredMessage: (id, content) => this.sendStructuredMessage(id, content),
      },
    });
  }

  /** What a process is started with (sessions/spawn-injection.ts). */
  private readonly injection: SpawnInjection;
  /** Starts the process of a thread (sessions/thread-spawner.ts). */
  private readonly spawner: ThreadSpawner;
  /** The notices to the thread that started a worker (sessions/coordinator-notifier.ts). */
  private readonly notifier: CoordinatorNotifier;
  /** The settings of one thread (sessions/thread-settings-service.ts). */
  private readonly settings: ThreadSettings;
  /** The answers to the question or gated tool of a structured thread (sessions/thread-questions.ts). */
  private readonly questions: ThreadQuestions;
  /** Where a path that a thread names is, and a file reference typed into a CLI (sessions/thread-files.ts). */
  private readonly files: ThreadFiles;
  /** The messages to a thread and the overseer message log (sessions/thread-messages.ts). */
  private readonly messages: ThreadMessages;
  /** The boot kickstart and the shutdown that keeps interrupted turns (sessions/boot-recovery.ts). */
  private readonly bootRecovery: BootRecovery;

  /** Where a thread's transcript is, and the reads of it (sessions/thread-transcripts.ts). */
  private readonly transcripts: ThreadTranscripts;

  /**
   * The one writer of a thread's config (W2-A). Every config write in this class is a patch of
   * the keys it changes; a copy of the config read earlier is for decisions only, never written.
   */
  private readonly configStore: ThreadConfigStore;

  setDaemonPort(port: number): void { this.wiring.daemonPort = port; }

  setDaemonApi(url: string): void { this.wiring.daemonApi = url.replace(/\/+$/, ''); }
  setKeyRegistry(registry: KeyRegistry, opts: { keyDir?: string; codexSticky?: boolean } = {}): void {
    if (this.wiring.threadKeys) return;
    const tk = new ThreadKeys(registry, opts);
    this.wiring.threadKeys = tk;
    if (typeof this.ptyManager.on === 'function') {
      this.ptyManager.on('exit', (id: string, _code: number, pid?: number) => {
        if (typeof pid === 'number') tk.onPtyExit(id, pid);
      });
    }
    this.harnesses.revokeKeysOnExitForAll();
  }

  /** The daemon's own stop: every key, the sticky Codex Pretty keys too. */
  revokeEveryKey(): void { this.wiring.threadKeys?.revokeAll(); }

  /** Stop, stop-all: the current key of a terminal (the sticky Codex Pretty key stays). */
  private revokeLiveKey(terminalId: string): void { this.wiring.threadKeys?.revokeLive(terminalId); }
  /** Archive, delete, switch to the CLI view: every key of a terminal, the sticky one too. */
  private revokeAllKeys(terminalId: string): void {
    this.wiring.threadKeys?.revokeLive(terminalId);
    this.wiring.threadKeys?.revokeSticky(terminalId);
  }

  setSecretsServerSpec(fn: () => { spec: McpServerSpec | null; prompt: string | null }): void {
    this.wiring.secretsServerSpec = fn;
  }

  setPluginInjection(fn: (harness: string, sessionId: string | null) => { specs: McpServerSpec[]; prompts: string[]; toolNames: string[] }): void {
    this.wiring.pluginInjection = fn;
  }
  setSpawnListener(fn: (terminalId: string, toolsAvailable: string[]) => void): void { this.wiring.onSpawned = fn; }
  private onStatusDeclared: ((terminalId: string, decl: import('../structured/manager.js').StatusDeclaration) => void) | null = null;
  setStatusDeclaredListener(fn: (terminalId: string, decl: import('../structured/manager.js').StatusDeclaration) => void): void { this.onStatusDeclared = fn; }

  setIntegrationsSpecs(fn: () => McpServerSpec[]): void {
    this.wiring.integrationsSpecs = fn;
  }

  setToolsAwareness(fn: () => string | null): void {
    this.wiring.toolsAwareness = fn;
  }

  registerStructuredManager(type: string, manager: import('../structured/manager.js').IStructuredManager): void { this.harnesses.registerStructuredManager(type, manager); }

  setStructuredManager(m: import('../structured/manager.js').IStructuredManager): void {
    this.registerStructuredManager('claude-code', m);
  }

  setStructuredCommandOverride(cmd: { command: string; args: string[] }): void { this.wiring.structuredCommandOverride = cmd; }

  /**
   * Wire the Codex structured (app-server) manager. Only called by server wiring when
   * CODEX_PRETTY_ENABLED — until then `structuredManagerFor('codex')` is undefined and
   * codex threads have only the PTY transport.
   */
  setCodexStructuredManager(m: import('../structured/manager.js').IStructuredManager): void {
    this.registerStructuredManager('codex', m);
  }

  /**
   * Wire the Grok structured (ACP) manager. Only called by server wiring when
   * GROK_PRETTY_ENABLED — until then `structuredManagerFor('grok')` is undefined and grok
   * threads have only the PTY transport. Unlike Codex, the Grok id must be persisted here:
   * `session/new` mints it exactly once, and resume after a daemon restart is `session/load`
   * by that stored external_id.
   */
  setGrokStructuredManager(m: import('../structured/manager.js').IStructuredManager): void {
    this.registerStructuredManager('grok', m);
  }

  /** Wire the OpenCode structured (ACP) manager. Same id-persistence contract as Grok:
   *  `session/new` mints the id exactly once; resume is `session/load` by external_id. */
  setOpencodeStructuredManager(m: import('../structured/manager.js').IStructuredManager): void {
    this.registerStructuredManager('opencode', m);
  }

  structuredManagerFor(type: string): import('../structured/manager.js').IStructuredManager | undefined { return this.harnesses.structuredManagerFor(type); }

  /** Public so the structured-ws upgrade handler can pick the RIGHT manager per connection (sessions/harness-registry.ts). */
  structuredManagerForTerminal(terminalId: string): import('../structured/manager.js').IStructuredManager | undefined { return this.harnesses.structuredManagerForTerminal(terminalId); }

  setStatusContext(ctx: StatusContext): void {
    this.wiring.statusContext = ctx;
  }

  create(input: CreateSessionInput): Session {
    const id = uuid();
    const name = input.name || 'New Project';
    // `~` is expanded here, once (box defect #3: a stored `~/x` reached chdir(2) unexpanded). A hosted box
    // creates a project from a name alone: ~/projects/<safe-name>, made and de-duplicated (defect #4).
    const given = input.workingDir?.trim();
    const workingDir = given ? expandHome(given) : isHostedBox() ? hostedProjectDir(name) : '~';

    // Ensure the project directory exists. A session row alone is not enough: the
    // first thread spawns a PTY with cwd=workingDir and dies with ENOENT if the
    // path isn't there. Locally you pick an existing directory so this is a no-op;
    // on a hosted box the user just NAMES a project and the directory has to be
    // created for them. recursive:true makes it idempotent, and a failure is
    // non-fatal — the session is still recorded, and the spawn error is clearer
    // than refusing to create the project at all.
    if (workingDir !== '~' && !workingDir.startsWith('~')) {
      try {
        fs.mkdirSync(workingDir, { recursive: true });
      } catch (err) {
        console.warn(`could not create project directory ${workingDir}:`, err);
      }
    }

    sessionsDb.create(this.db, {
      id,
      provider: input.provider || 'claude-code',
      name,
      workingDir,
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
      this.revokeLiveKey(terminal.id);
      this.wiring.usageLimits?.onStopped(terminal.id);
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
      this.revokeAllKeys(terminal.id);
      this.wiring.usageLimits?.onStopped(terminal.id);
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
    // The hard delete takes the archived threads' rows too: list them before it, for their files.
    const archived = terminalsDb.listArchivedBySession(this.db, id);
    // An archived thread kept its saved question for a restore. Now it is deleted, so the question goes too.
    for (const terminal of archived) watchesDb.removeForTerminal(this.db, terminal.id);
    terminalsDb.removeBySession(this.db, id);
    for (const terminal of [...terminals, ...archived]) this.removeThreadMcpConfig(terminal.id);

    if (this.ptyManager.isAlive(id)) this.ptyManager.kill(id);
    sessionsDb.archive(this.db, id);
  }

  // --- Terminal-level operations ---

  liveThreadCount(sessionId: string): number { return this.spawner.liveThreadCount(sessionId); }

  private assertRoomForLiveThread(sessionId: string): void { return this.spawner.assertRoomForLiveThread(sessionId); }

  createTerminal(sessionId: string, type: TerminalType, label?: string, skipPermissions?: boolean, workingDir?: string, externalId?: string, config?: Record<string, any>): terminalsDb.Terminal {
    const session = sessionsDb.getById(this.db, sessionId);
    if (!session) throw new Error('Session not found');
    this.assertRoomForLiveThread(sessionId);

    const resolvedDir = workingDir
      ? expandHome(workingDir)
      : expandHome(session.working_dir);

    if (workingDir && !isWorktreeFolder(resolvedDir)) {
      appState.set(this.db, 'last_directory', resolvedDir);
    }

    const terminalId = uuid();
    const labelSource: 'user' | 'default' = label ? 'user' : 'default';
    const displayLabel = label || this.defaultTerminalLabel(sessionId, type);

    // Grok is structured-only for NEW threads: its PTY/TUI never rendered well in Dispatch
    // (mobile paging, alt-screen churn), so any creation path that doesn't name a transport
    // gets Pretty. Applied at creation, never at spawn — existing PTY rows keep working, and
    // an explicit `transport` in the request still wins. Skipped when the structured manager
    // is absent (DISPATCH_GROK_PRETTY=0 falls back to PTY).
    if (type === 'grok' && !config?.transport && this.structuredManagerFor('grok')) {
      config = { ...(config ?? {}), transport: 'structured' };
    }
    // OpenCode is Pretty-ONLY — there is no PTY provider at all, so unlike Grok this is
    // not conditional on a transport already being named: every opencode row is structured.
    if (type === 'opencode') {
      config = { ...(config ?? {}), transport: 'structured' };
    }

    terminalsDb.create(this.db, {
      id: terminalId,
      sessionId,
      type,
      label: displayLabel,
      labelSource,
      skipPermissions,
      workingDir: resolvedDir,
      externalId,
      config: withRootSpawnDepth(config),
    });

    try {
      this.spawnTerminal(terminalId);
    } catch (err: any) {
      terminalsDb.remove(this.db, terminalId);
      this.removeThreadMcpConfig(terminalId);
      throw new Error(`Failed to start ${displayLabel}: ${clientMessage(err)}`);
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
      config: withRootSpawnDepth({ ...(config ?? {}), queued: true, queuedTask: task }),
    });
    this.setTerminalStatus(terminalId, 'queued');

    // dependsOn may already be satisfied (the depended-on agent finished — or was
    // archived — before this one was even queued). Don't leave it waiting forever
    // on an `idle` event that already fired; promote it right away.
    const dependsOn = typeof config?.dependsOn === 'string' ? config.dependsOn : '';
    if (dependsOn && this.isAgentDone(dependsOn)) {
      this.startQueuedTerminal(terminalId, this.composeDependentTask(dependsOn, task), { enforceCap: false });
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
  startQueuedTerminal(terminalId: string, taskOverride?: string, opts: { enforceCap?: boolean } = {}): terminalsDb.Terminal | null {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return null;
    let config: Record<string, any> = {};
    try { config = JSON.parse(terminal.config || '{}'); } catch { /* default {} */ }
    if (config.queued !== true) return terminalsDb.rowToTerminal(terminal); // not queued — nothing to promote
    if (opts.enforceCap !== false) this.assertRoomForLiveThread(terminal.session_id); // before the markers are stripped, so a refusal changes nothing

    const task = typeof taskOverride === 'string' ? taskOverride : (typeof config.queuedTask === 'string' ? config.queuedTask : '');
    // Strip the queued markers BEFORE spawning so the row reads as a normal live
    // thread (and the ensureStructuredAlive guard no longer bails on it). dependsOn
    // is stripped too — once started, whether early (override) or auto (dependency
    // met), it's no longer meaningfully "waiting" on anything.
    this.configStore.patch(terminalId, { queued: null, queuedTask: null, dependsOn: null });
    this.setTerminalStatus(terminalId, 'waiting');

    this.spawnTerminal(terminalId);
    if (task) {
      // The parked task is not the owner's words: the thread that queued it wrote it (coach fix T1).
      this.sendStructuredMessage(terminalId, task, 'coordinator');
      this.noteUserPrompt(terminalId, task, 'thread');
    }

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

    if (workingDir && !isWorktreeFolder(resolvedDir)) {
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
      config: withRootSpawnDepth({ runner: true, runnerPrompt: prompt }),
    });

    try {
      this.spawnTerminal(terminalId);
    } catch (err: any) {
      terminalsDb.remove(this.db, terminalId);
      this.removeThreadMcpConfig(terminalId);
      throw new Error(`Failed to start ${displayLabel}: ${clientMessage(err)}`);
    }

    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, terminalId)!);
  }

  /**
   * Branch (fork) an agent thread (Claude Code, Codex, Grok) into a NEW thread. Resolves the source
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
      this.removeThreadMcpConfig(terminalId);
      throw new Error(`Failed to branch: ${clientMessage(err)}`);
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

  /**
   * Update any tab: rename it, or set the config keys a client may set (CLIENT_SETTABLE_KEYS: a
   * notes tab's `html`, a browser tab's `url`). The client's config is a PATCH, not a replacement
   * (W2-A): a key it does not send stays, a key sent as `null` is removed, and a key outside the
   * allow-list is ignored. Every other setting has its own route (model, effort, transport,
   * account, autonomy, auto-archive, alerts, secrets-env).
   */
  updateTab(tabId: string, fields: { label?: string; config?: Record<string, any> }): terminalsDb.Terminal | null {
    const row = terminalsDb.getById(this.db, tabId);
    if (!row) return null;
    if (fields.label) terminalsDb.updateLabel(this.db, tabId, fields.label);
    if (fields.config !== undefined && fields.config !== null) {
      if (typeof fields.config !== 'object' || Array.isArray(fields.config)) {
        console.warn(`[thread-config] thread ${tabId}: a client config that is not an object was ignored`);
      } else {
        const { patch, ignored } = pickClientSettable(fields.config);
        const sent = fields.config;
        this.configStore.patch(tabId, (current) => {
          // A client that sends its whole copy back (the notes tab does) repeats keys it did not
          // change: only a key whose value differs from the saved one is worth a log line.
          const refused = ignored.filter((k) => JSON.stringify(sent[k]) !== JSON.stringify(current[k]));
          if (refused.length) {
            console.warn(`[thread-config] thread ${tabId}: ignored config keys from a client (not client-settable): ${refused.map((k) => JSON.stringify(k.slice(0, 60))).join(', ')}`);
          }
          return Object.keys(patch).length ? patch : null;
        });
      }
    }
    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, tabId)!);
  }

  setAutoArchive(terminalId: string, enabled: boolean, ms: number = DEFAULT_AUTO_ARCHIVE_MS): terminalsDb.Terminal | null { return this.settings.setAutoArchive(terminalId, enabled, ms); }

  setAlertsEnabled(terminalId: string, enabled: boolean): terminalsDb.Terminal | null { return this.settings.setAlertsEnabled(terminalId, enabled); }

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

  historyOwnedByRest(terminalId: string): boolean { return this.transcripts.historyOwnedByRest(terminalId); }

  historyRestPageable(terminalId: string): boolean { return this.transcripts.historyRestPageable(terminalId); }

  getConversation(terminalId: string, opts: ConvPageOptions = {}): Promise<ConvPage> { return this.transcripts.getConversation(terminalId, opts); }

  private conversationTail(terminalId: string, limit: number): ConvItem[] { return this.transcripts.conversationTail(terminalId, limit); }

  searchConversation(terminalId: string, query: string, limit = 200): Promise<{ matches: SearchMatch[] }> { return this.transcripts.searchConversation(terminalId, query, limit); }

  private recoverSessionId(terminalId: string, dir: string): string | null { return this.transcripts.recoverSessionId(terminalId, dir); }

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
      this.setTerminalStatus(terminalId, 'error');
    }

    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, terminalId)!);
  }

  /** Restart a thread: kill the running process (if any) and re-spawn it fresh. */
  async restartTerminal(terminalId: string): Promise<terminalsDb.Terminal | null> {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return null;
    if (!terminalsDb.isPtyType(terminal.type)) return terminalsDb.rowToTerminal(terminal);

    // Kill whichever transport actually backs the thread. A structured thread lives in
    // its manager, not the PTY table — killing only via ptyManager left it alive, and
    // spawnStructured bails while the manager still reports alive, making relaunch a
    // silent no-op. The respawn is what re-reads the MCP config (tools load at spawn),
    // so the coordinator's "Restart session" action depends on this kill landing.
    const current = this.isStructuredTerminal(terminal) ? ('structured' as const) : ('pty' as const);
    await this.killCurrentTransport(terminal.type, terminalId, current);
    return this.relaunchTerminal(terminalId);
  }

  stopTerminal(terminalId: string): void {
    this.wiring.usageLimits?.onStopped(terminalId);
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return;
    this.revokeLiveKey(terminalId);
    this.ptyManager.kill(terminalId);
    this.structuredManagerFor(terminal.type)?.kill(terminalId);
    terminalsDb.updatePid(this.db, terminalId, null);
  }

  sendStructuredMessage(
    terminalId: string,
    content: string | import('../structured/manager.js').ContentBlock[],
    source?: import('../structured/manager.js').MessageSource,
    logAs?: coordinatorMessagesDb.CoordinatorMessageSource,
  ): void { return this.messages.sendStructuredMessage(terminalId, content, source, logAs); }

  private logCoordinatorMessage(terminalId: string, content: string | import('../structured/manager.js').ContentBlock[], source: coordinatorMessagesDb.CoordinatorMessageSource): void { return this.messages.logCoordinatorMessage(terminalId, content, source); }

  /**
   * True when this terminal actually runs the structured (Pretty) transport — BOTH the config
   * flag and a registered manager for its type, the same pair spawnTerminal/ensureStructuredAlive
   * gate on (a `transport: 'structured'` codex row is still a PTY when Codex-Pretty is disabled).
   */
  isStructuredTerminal(terminal: terminalsDb.TerminalRow): boolean {
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(terminal.config || '{}'); } catch { /* default {} */ }
    return config.transport === 'structured' && !!this.structuredManagerFor(terminal.type);
  }

  sendThreadMessage(
    terminalId: string,
    content: string | import('../structured/manager.js').ContentBlock[],
    source?: import('../structured/manager.js').MessageSource,
    logAs?: coordinatorMessagesDb.CoordinatorMessageSource,
    fromProject?: import('../auth/key-rules.js').SenderFacts,
  ): { transport: 'structured' | 'pty'; droppedNonText: boolean; delivered?: string | import('../structured/manager.js').ContentBlock[] } { return this.messages.sendThreadMessage(terminalId, content, source, logAs, fromProject); }

  private outbox?: DeliveryOutbox;
  /** The daemon's delivery outbox (server wiring: delivery/wiring.ts). */
  setDeliveryOutbox(outbox: DeliveryOutbox): void { this.outbox = outbox; }
  /** The delivery outbox. A service that got none (a unit test) makes one on its own database, with no event wired. */
  get deliveryOutbox(): DeliveryOutbox {
    return (this.outbox ??= new DeliveryOutbox({ db: this.db, now: () => this.clock(), deliver: (id, body, kind) => this.deliverOutboxRow(id, body, kind) }));
  }

  deliverOutboxRow(targetId: string, body: string, _kind: OutboxKind): DeliverResult { return this.notifier.deliverOutboxRow(targetId, body, _kind); }

  /** True when a CLI (PTY) process backs the thread now: text typed into it reaches a program. */
  isPtyAlive(terminalId: string): boolean {
    return this.ptyManager.isAlive(terminalId);
  }

  /** True when a process backs the thread now: its CLI (PTY) process, or its structured (Pretty) process. */
  isProcessAlive(terminalId: string): boolean {
    return this.ptyManager.isAlive(terminalId) || !!this.structuredManagerForTerminal(terminalId)?.isAlive(terminalId);
  }

  /** A question that only the database still holds after a restart (sessions/boot-reconcile.ts, W2-C). */
  private restoredQuestions?: import('./boot-reconcile.js').RestoredQuestions;
  setRestoredQuestions(r: import('./boot-reconcile.js').RestoredQuestions): void { this.restoredQuestions = r; }

  sendInterimRecapNotice(coordinatorId: string, newCount: number, workingCount: number, queuedCount = 0): boolean { return this.notifier.sendInterimRecapNotice(coordinatorId, newCount, workingCount, queuedCount); }

  /** The overseer's agents in this project, sorted into working / queued / waiting on the overseer. */
  batchState(sessionId: string, opts: BatchOptions = {}): BatchState {
    return computeBatchState(this.db, sessionId, opts, (id) => this.getPendingPermission(id) !== null);
  }

  routeAgentQuestionToCoordinator(agentTerminalId: string, pending: { toolName?: string; questions?: any[] }): boolean { return this.notifier.routeAgentQuestionToCoordinator(agentTerminalId, pending); }

  noteAgentLifecycle(agentTerminalId: string, kind: 'stopped' | 'interrupted'): void { return this.notifier.noteAgentLifecycle(agentTerminalId, kind); }

  noteUserMessageToAgent(agentTerminalId: string, payload: string | import('../structured/manager.js').ContentBlock[]): void { return this.notifier.noteUserMessageToAgent(agentTerminalId, payload); }

  private noteQuestionAnsweredInChat(agentTerminalId: string, reply: string, imageCount: number, canned?: QuestionCannedAction): void { return this.notifier.noteQuestionAnsweredInChat(agentTerminalId, reply, imageCount, canned); }

  lastAssistantTextPublic(terminalId: string, max = 400): string { return this.notifier.lastAssistantTextPublic(terminalId, max); }

  private agentOutputText(terminalId: string, max = 600): string { return this.notifier.agentOutputText(terminalId, max); }

  private isAgentDone(terminalId: string): boolean { return this.notifier.isAgentDone(terminalId); }

  private composeDependentTask(finishedTerminalId: string, originalTask: string): string { return this.notifier.composeDependentTask(finishedTerminalId, originalTask); }

  noteAgentCompletion(agentTerminalId: string): void { return this.notifier.noteAgentCompletion(agentTerminalId); }

  private ledgerService?: LedgerService;
  private onLedgerChange?: (sessionId: string) => void;
  /** Runs after every write of this service's ledger (the owner-decisions capture); set by the server wiring. */
  setLedgerChangeListener(listener: (sessionId: string) => void): void { this.onLedgerChange = listener; }
  /** The decision ledger, on this service's clock (tests pin it). */
  private get ledger(): LedgerService {
    return (this.ledgerService ??= new LedgerService(this.db, { clock: () => this.clock(), onChange: (id) => this.onLedgerChange?.(id) }));
  }

  finalOutput(terminalId: string): string { return this.notifier.finalOutput(terminalId); }

  noteAgentNeedsHelp(agentTerminalId: string, ask: string): void { return this.notifier.noteAgentNeedsHelp(agentTerminalId, ask); }

  noteTurnOutcome(terminalId: string, detail: { summary: string; needsHelp: boolean; inferred: boolean; state?: 'done' | 'blocked'; blocker?: string }): void { return this.notifier.noteTurnOutcome(terminalId, detail); }

  setBoardState(terminalId: string, patch: { acknowledged?: boolean; override?: string | null }): boolean { return this.notifier.setBoardState(terminalId, patch); }

  /**
   * Should the Pretty view offer to summarize before resuming this thread?
   * Claude-only and transcript-backed: a thread with no external_id has no
   * conversation to resume, and Codex resumes out-of-band over JSON-RPC.
   */
  getResumeAdvice(terminalId: string): ResumeAdvice | null {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal?.external_id || terminal.type !== 'claude-code') return null;
    const session = sessionsDb.getById(this.db, terminal.session_id);
    const workDir = terminal.working_dir || session?.working_dir;
    if (!workDir) return null;
    return readResumeAdvice(workDir, terminal.external_id);
  }

  /** The gated tool/question a structured AGENT thread is blocked on, or null. */
  getPendingPermission(terminalId: string): import('../structured/manager.js').PendingPermission | null {
    // W2-C: a question asked before a daemon restart is not in the new manager's memory; the saved one is shown again.
    return this.structuredManagerForTerminal(terminalId)?.getPending(terminalId) ?? this.restoredQuestions?.get(terminalId) ?? null;
  }

  /** The terminal's current PTY scrollback ring size in bytes (0 if not live). */
  getScrollbackSize(terminalId: string): number {
    return this.ptyManager.getBufferSize(terminalId);
  }

  /**
   * The scrollback ring's retained size PLUS where it sits in the process's
   * lifetime output: `startOffset` is the absolute position of the first retained
   * byte, `totalWritten` counts every byte ever written (evicted ones included).
   */
  getScrollbackInfo(terminalId: string): { totalBytes: number; startOffset: number; totalWritten: number } {
    const { startOffset, totalWritten } = this.ptyManager.getBufferOffsets(terminalId);
    return { totalBytes: this.ptyManager.getBufferSize(terminalId), startOffset, totalWritten };
  }

  answerPermission(
    terminalId: string,
    requestId: string,
    opts: { decision: 'allow' | 'deny'; answers?: Record<string, string>; message?: string; canned?: QuestionCannedAction; logAs?: 'user' | 'coordinator' },
  ): boolean { return this.questions.answerPermission(terminalId, requestId, opts); }

  answerQuestionInChat(terminalId: string, requestId: string, reply: string, imageCount = 0, from: 'user' | 'chat' = 'user'): 'delivered' | 'not-found' | 'unsupported' { return this.questions.answerQuestionInChat(terminalId, requestId, reply, imageCount, from); }

  setAutonomy(terminalId: string, mode: 'supervised' | 'autonomous'): boolean { return this.settings.setAutonomy(terminalId, mode); }

  /** Gracefully interrupt a structured thread's current turn (does NOT kill it). */
  interrupt(terminalId: string): boolean {
    this.wiring.usageLimits?.onStopped(terminalId);
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
   * Record an agent's own account of how its turn ended. When a live structured session
   * backs the thread, it's stored there and consulted at the `result` boundary — see
   * StructuredSessionManager.noteDeclaredStatus. Otherwise (PTY/CLI threads — no in-process
   * session for the hook process to write into) it falls back to persisting onto the
   * terminal row: PTY/CLI threads' turn boundary is the `Stop` hook, which runs in a
   * different process and can't see an in-memory session, so the declaration has to survive
   * on the row until that hook fires — see StatusService.ingest's Stop-hook consult/clear.
   * Returns false only when the terminal itself doesn't exist.
   */
  reportStatus(terminalId: string, decl: import('../structured/manager.js').StatusDeclaration): boolean {
    decl = redactKeysDeep(decl);
    try { this.onStatusDeclared?.(terminalId, decl); } catch { /* observers never block a declaration */ }
    const manager = this.structuredManagerForTerminal(terminalId);
    if (manager && manager.isAlive(terminalId)) {
      manager.noteDeclaredStatus(terminalId, decl);
      return true;
    }
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return false;
    try { this.configStore.patch(terminalId, { pendingDeclaration: decl }); } catch { return false; }
    return true;
  }

  switchTransport(terminalId: string, target: 'structured' | 'pty', opts?: { force?: boolean }): Promise<terminalsDb.Terminal> { return this.settings.switchTransport(terminalId, target, opts); }

  switchAccount(terminalId: string, accountId: string, opts?: { force?: boolean }): Promise<terminalsDb.Terminal> { return this.settings.switchAccount(terminalId, accountId, opts); }

  activeModel(terminalId: string): string | undefined { return this.settings.activeModel(terminalId); }

  private onTerminalChanged?: (sessionId: string) => void;
  /** Runs when the daemon changes a thread's saved settings on its own (a late refusal put a pick back); the server tells the web. */
  setTerminalChangedListener(listener: (sessionId: string) => void): void { this.onTerminalChanged = listener; }

  private undoRefusedPick(terminalId: string, info: { model?: string; effort?: string; restoredModel?: string }): void { return this.settings.undoRefusedPick(terminalId, info); }

  codexModelEfforts(): Promise<Record<string, string[]> | null> { return this.settings.codexModelEfforts(); }
  codexModelDefaults(): Record<string, string> | null { return this.settings.codexModelDefaults(); }
  private codexEffortFor(config: Record<string, any>, model?: string): string | undefined { return this.settings.codexEffortFor(config, model); }

  setThreadModel(terminalId: string, model: string): Promise<{ model: string; terminal: terminalsDb.Terminal; clearedEffort?: string; effortNow?: string }> { return this.settings.setThreadModel(terminalId, model); }

  setThreadEffort(terminalId: string, effort: string): Promise<{ effort: string; terminal: terminalsDb.Terminal }> { return this.settings.setThreadEffort(terminalId, effort); }

  handleTypedSlash(terminalId: string, content: unknown, source: import('../structured/manager.js').MessageSource | undefined): Promise<terminalsDb.Terminal | null> { return this.settings.handleTypedSlash(terminalId, content, source); }

  private killCurrentTransport(type: string, terminalId: string, current: 'structured' | 'pty'): Promise<void> { return this.settings.killCurrentTransport(type, terminalId, current); }

  /**
   * The project's live coordinator thread, any agent harness (null when none). Widened to
   * any agent harness (`isAgentType`), not just `claude-code`: Phase 1 still CREATES only
   * claude-code coordinators (see `ensureCoordinator`), but a Phase 2 coordinator on another
   * harness must be FOUND here, not shadowed by a new claude-code one.
   */
  findCoordinator(sessionId: string): terminalsDb.Terminal | null {
    return findLiveCoordinator(this.db, sessionId);
  }

  /**
   * Find-or-create the project's Overseer coordinator: a structured thread tagged
   * `config.role === 'coordinator'`. Returns the existing one if a non-archived
   * coordinator already exists, else spawns a new one labeled "Overseer" via the
   * normal createTerminal path. Idempotent (one per project).
   *
   * `opts` (model, workerHarness, coordinatorHarness) apply ONLY on create. They are ignored
   * when an existing coordinator is found: the setup card that supplies these options only
   * shows when no coordinator exists yet, so in the normal flow they don't arrive on a
   * find-existing call. A cross-client race (two callers hitting this at once) CAN still
   * deliver opts alongside a find-existing outcome — that is fine, since ignoring them here
   * is the intended behavior either way.
   *
   * `coordinatorHarness` picks WHICH harness backs the coordinator itself (defaults to
   * claude-code, Phase 1's only option) — distinct from `workerHarness`, which picks the
   * default harness for AGENTS the coordinator spawns. The route validates it against the
   * `coordinator` capability (see providers/capabilities.ts) before this is ever called, so
   * by the time it lands here it is trusted.
   */
  ensureCoordinator(sessionId: string, opts: { model?: string; workerHarness?: AgentType; coordinatorHarness?: AgentType } = {}): terminalsDb.Terminal {
    const session = sessionsDb.getById(this.db, sessionId);
    if (!session) throw new Error('Session not found');

    const existing = this.findCoordinator(sessionId);
    if (existing) {
      // A coordinator record can outlive its process (daemon restart). Revive it so
      // the caller gets a LIVE coordinator (resume if a session was captured, else fresh)
      // instead of a dead one that silently swallows directives.
      this.ensureStructuredAlive(existing.id);
      return existing;
    }

    return this.createTerminal(
      sessionId,
      opts.coordinatorHarness ?? 'claude-code',
      'Overseer',
      undefined,
      undefined,
      undefined,
      {
        transport: 'structured', role: 'coordinator',
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.workerHarness ? { workerHarness: opts.workerHarness } : {}),
      },
    );
  }

  writeToTerminal(terminalId: string, data: string): void {
    this.ptyManager.write(terminalId, data);
  }

  resolveTerminalFilePath(terminalId: string, requestedPath: string): string | null { return this.files.resolveTerminalFilePath(terminalId, requestedPath); }

  sendFileReference(terminalId: string, requestedPath: string, mode: 'agent-context' | 'shell-path' = 'agent-context'): { sentText: string } | null { return this.files.sendFileReference(terminalId, requestedPath, mode); }

  stopAllTerminals(): void {
    this.wiring.threadKeys?.revokeAllLive(); // PTY keys only: Pretty threads keep running, so their keys stay
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
    this.revokeAllKeys(terminalId);
    // An archived thread can never resume: drop its usage-limit pause (parked or capped) so the banner and chip clear.
    this.wiring.usageLimits?.onStopped(terminalId);
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
    // The saved question stays: a restore shows its card again. The delete of the project removes it.
    watchesDb.removeForTerminal(this.db, terminalId, { keepQuestion: true });
    // A restore re-spawns, which writes the file again.
    this.removeThreadMcpConfig(terminalId);
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
        this.setTerminalStatus(terminalId, 'error');
      }
    }
    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, terminalId)!);
  }

  listArchivedTerminals(sessionId: string): terminalsDb.Terminal[] {
    return terminalsDb.listArchivedBySession(this.db, sessionId).map(terminalsDb.rowToTerminal);
  }

  private spawnTerminal(terminalId: string): void { return this.spawner.spawnTerminal(terminalId); }

  ensureStructuredAlive(terminalId: string): boolean { return this.spawner.ensureStructuredAlive(terminalId); }

  kickstartInterruptedAgents(settleMs?: number): Promise<{ kicked: string[]; skipped: string[]; completed: string[] }> { return this.bootRecovery.kickstartInterruptedAgents(settleMs); }

  shutdownPreservingInterruptedTurns(stopAll: () => void): string[] { return this.bootRecovery.shutdownPreservingInterruptedTurns(stopAll); }

  private removeThreadMcpConfig(terminalId: string): void { return this.injection.removeThreadMcpConfig(terminalId); }

  private defaultTerminalLabel(sessionId: string, type: TerminalType): string {
    const terminals = terminalsDb.listBySession(this.db, sessionId);
    const sameType = terminals.filter(t => t.type === type);

    switch (type) {
      case 'claude-code': return sameType.length > 0 ? `Claude Code #${sameType.length + 1}` : 'Claude Code';
      case 'codex': return sameType.length > 0 ? `Codex #${sameType.length + 1}` : 'Codex';
      case 'grok': return sameType.length > 0 ? `Grok #${sameType.length + 1}` : 'Grok';
      case 'opencode': return sameType.length > 0 ? `OpenCode #${sameType.length + 1}` : 'OpenCode';
      case 'shell': return sameType.length > 0 ? `Terminal #${sameType.length + 1}` : 'Terminal';
    }
  }

  private autoName(workDir: string): string {
    const folder = workDir.split('/').pop() || 'session';
    const existing = sessionsDb.list(this.db).filter(s => s.name.startsWith(folder));
    return existing.length > 0 ? `${folder} #${existing.length + 1}` : folder;
  }

}
