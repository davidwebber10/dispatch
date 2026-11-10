import { redactKeys } from '../auth/redact-keys.js';
import { clientMessage } from '../http/client-message.js';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import * as messageSourceDb from '../db/message-source.js';
import { getProvider } from '../providers/registry.js';
import { PTYManager } from '../pty/manager.js';
import type { KeyHandle, KeyRegistry } from '../auth/principals.js';
import { composeInjection, type McpServerSpec } from '../mcp/injection.js';
import { readCodexSessionModel } from './codex-sessions.js';
import { platform } from '../platform/index.js';
import { maxLiveThreadsPerProject } from '../caps.js';
import { systemPromptFor, modelFor } from '../overseer/prompts.js';
import { resolveSpawnModel, isClaudeTierAlias } from '../overseer/spawn-model.js';
import { COORDINATOR_DISALLOWED_TOOLS, makeCoordinatorPolicy } from '../overseer/coordinator-policy.js';
import { ROLE_DISALLOWED_TOOLS, roleToolPolicy } from '../roles/role-policy.js';
import { adoptTranscriptSettings as adoptTranscriptSettingsInto, effortFor } from './thread-settings.js';
import { readSessionBackfill, readSessionSettings, applyDurableSources, resumeAdvice as readResumeAdvice } from './cc-sessions.js';
import { randomUUID } from 'crypto';
import { effectiveSpawnDepth } from '../auth/key-scope.js';
import { COORDINATOR_CAPABLE_HARNESSES } from '../providers/capabilities.js';
import { writeGrokHome } from '../providers/grok-home.js';
import { writeOpencodeConfig } from '../providers/opencode-config.js';
import { modelSupportsToolsCached } from '../settings/model-capabilities.js';
import { OPENCODE_DEFAULT_MODEL } from '../providers/opencode.js';
import { readHarnessSettings } from '../settings/harness-settings.js';
import { TERMINAL_ID_ENV_VAR } from '../auth/shim.js';
import { LOGIN_ARGV, isProviderName } from '../setup/install.js';
import { ThreadConfigStore, type ConfigPatch } from './thread-config.js';
import type { SessionWiring } from './session-wiring.js';
import { AGENCY_MCP_SERVER, type SpawnInjection } from './spawn-injection.js';

type IStructuredManager = import('../structured/manager.js').IStructuredManager;

/** The key minted for one process start. `keyFile` is set for the Codex CLI view only. */
export interface SpawnKey { key: string; handle: KeyHandle; keyFile?: string }

/** Tools stripped from a structured Claude thread's toolset at spawn (--disallowedTools): the
 *  coordinator's native orchestration, and a role run's Dispatch delegation/steering tools. The
 *  membrane policy denies both too; stripping means the model never sees them. */
export function disallowedToolsFor(config: Record<string, any>): string[] | undefined {
  if (config.role === 'coordinator') return [...COORDINATOR_DISALLOWED_TOOLS];
  if (typeof config.roleAuthority === 'string') return [...ROLE_DISALLOWED_TOOLS];
  return undefined;
}

/** What ThreadSpawner needs. Every field is required. */
export interface ThreadSpawnerDeps {
  db: Database.Database;
  /** The one writer of a thread's config. */
  configStore: ThreadConfigStore;
  /** The CLI processes. */
  pty: Pick<PTYManager, 'isAlive' | 'spawn'>;
  /** What the daemon handed over after the services were built. Read at each spawn. */
  wiring: SessionWiring;
  /** What a process is started with: MCP config, servers, prompts, hooks, memory folders. */
  injection: SpawnInjection;
  /** The thread operations that a spawn uses. SessionService gives its own methods. */
  threads: {
    structuredManagerFor(type: string): IStructuredManager | undefined;
    /** The effort a Codex thread starts with, checked against the efforts of its model. */
    codexEffortFor(config: Record<string, any>, model?: string): string | undefined;
  };
}

/**
 * Starts the process of a thread (W3-B: moved out of SessionService): the CLI (PTY) spawn, the
 * structured spawn, the key of each process, the start of a dead Pretty thread on demand, and the
 * cap of live threads per project.
 */
export class ThreadSpawner {
  constructor(private readonly deps: ThreadSpawnerDeps) {}

  /** Why the last revive of a structured thread failed, so a send can say so (#76). */
  readonly lastSpawnError = new Map<string, string>();

  // The inputs under the names the moved code uses.
  private get db(): Database.Database { return this.deps.db; }
  private get configStore(): ThreadConfigStore { return this.deps.configStore; }
  private get ptyManager(): Pick<PTYManager, 'isAlive' | 'spawn'> { return this.deps.pty; }
  private get wiring(): SessionWiring { return this.deps.wiring; }
  private structuredManagerFor(type: string): IStructuredManager | undefined { return this.deps.threads.structuredManagerFor(type); }
  private codexEffortFor(config: Record<string, any>, model?: string): string | undefined { return this.deps.threads.codexEffortFor(config, model); }
  private get isPeerEligible(): SpawnInjection['isPeerEligible'] { return (...a) => this.deps.injection.isPeerEligible(...a); }
  private get agencyServerSpec(): SpawnInjection['agencyServerSpec'] { return (...a) => this.deps.injection.agencyServerSpec(...a); }
  private get peerPromptFor(): SpawnInjection['peerPromptFor'] { return (...a) => this.deps.injection.peerPromptFor(...a); }
  private get applyPluginInjection(): SpawnInjection['applyPluginInjection'] { return (...a) => this.deps.injection.applyPluginInjection(...a); }
  private get perTerminalMcpConfigPath(): SpawnInjection['perTerminalMcpConfigPath'] { return (...a) => this.deps.injection.perTerminalMcpConfigPath(...a); }
  private get buildStatusHooks(): SpawnInjection['buildStatusHooks'] { return (...a) => this.deps.injection.buildStatusHooks(...a); }
  private get mcpEntries(): SpawnInjection['mcpEntries'] { return (...a) => this.deps.injection.mcpEntries(...a); }
  private get coordinatorMemoryFoldersFor(): SpawnInjection['coordinatorMemoryFoldersFor'] { return (...a) => this.deps.injection.coordinatorMemoryFoldersFor(...a); }
  private get overseerMemoryFor(): SpawnInjection['overseerMemoryFor'] { return (...a) => this.deps.injection.overseerMemoryFor(...a); }

  /**
   * Mint the key of a process that is about to start. Task 13 puts `key` into the environment or
   * the harness config and `keyFile` (Codex CLI view only) into DISPATCH_AUTH_FILE. null when no
   * registry is set.
   */
  private mintSpawnKey(terminalId: string, kind: 'thread' | 'shell', opts: { codexPretty?: boolean; keyFile?: boolean } = {}): SpawnKey | null {
    const tk = this.wiring.threadKeys;
    if (!tk) return null;
    const minted = opts.codexPretty ? tk.codexKey(terminalId) : tk.mintForSpawn(terminalId, kind);
    if (!opts.keyFile) return minted;
    try {
      return { ...minted, keyFile: tk.writeKeyFile(terminalId, minted.key, minted.handle) };
    } catch (err) {
      tk.spawnFailed(minted.handle);
      throw err;
    }
  }

  /** Threads of this project with a live process (a PTY or a structured session): what the live-thread cap counts. */
  liveThreadCount(sessionId: string): number {
    let n = 0;
    for (const t of terminalsDb.listBySession(this.db, sessionId)) {
      if (this.ptyManager.isAlive(t.id) || this.structuredManagerFor(t.type)?.isAlive(t.id)) n++;
    }
    return n;
  }

  /** Throws when the project is at its cap of live threads (DISPATCH_MAX_LIVE_THREADS; 0 = no cap). */
  assertRoomForLiveThread(sessionId: string): void {
    const cap = maxLiveThreadsPerProject();
    if (!cap) return;
    const live = this.liveThreadCount(sessionId);
    if (live >= cap) {
      throw new Error(`This project already has ${live} live threads (the limit is ${cap}). Archive or stop some, or raise DISPATCH_MAX_LIVE_THREADS.`);
    }
  }

  /**
   * Every PTY spawn goes through here: create, start of a queued agent, runner, branch, relaunch,
   * restart, restore and transport switch. A PTY process gets its key minted right before it
   * starts; a structured thread mints its own in spawnStructured. A spawn that throws revokes the
   * key it minted.
   */
  spawnTerminal(terminalId: string): void {
    const row = terminalsDb.getById(this.db, terminalId);
    let sk: SpawnKey | null = null;
    if (row && this.wiring.threadKeys) {
      let cfg: Record<string, any> = {};
      try { cfg = JSON.parse(row.config || '{}'); } catch { /* default {} */ }
      // A refused coordinator throws in the body before anything starts, so it mints nothing here.
      const structured = cfg.transport === 'structured' && !!this.structuredManagerFor(row.type);
      if (!structured && !(cfg.role === 'coordinator')) {
        // The Codex CLI view writes its environment to a snapshot file, so its key travels as a
        // 0600 key file and only the path goes into the environment (probe results, Finding 1).
        sk = this.mintSpawnKey(terminalId, row.type === 'shell' ? 'shell' : 'thread', { keyFile: row.type === 'codex' });
      }
    }
    try {
      this.spawnTerminalKeyed(terminalId, sk);
    } catch (err) {
      if (sk) this.wiring.threadKeys?.spawnFailed(sk.handle);
      throw err;
    }
  }

  private spawnTerminalKeyed(terminalId: string, sk: SpawnKey | null): void {
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

    // Fail closed for a coordinator that cannot run governed — see assertCoordinatorGoverned.
    // Checked HERE, before the shell branch and before composeInjection writes a per-thread MCP file,
    // so a refused spawn leaves nothing behind; callers (createTerminal/relaunchTerminal/restore/ws)
    // catch this and surface the error. spawnStructured re-checks it for the revive path.
    this.assertCoordinatorGoverned(terminal, config);

    let command: string;
    let args: string[];
    /** Set when this provider names its own session — persisted only after a live pid. */
    let assignedSessionId: string | undefined;
    /** Set for Grok: the per-thread config home carrying its hooks and MCP servers. */
    let grokHomeDir: string | undefined;

    if (terminal.type === 'shell') {
      // A "Sign in — X" thread runs that CLI's login command DIRECTLY rather than a shell
      // we then type into: no racing a shell prompt, and the process is exactly the command
      // whose output Dispatch is watching for a sign-in URL.
      const signIn = typeof config.signIn === 'string' && isProviderName(config.signIn) ? LOGIN_ARGV[config.signIn] : null;
      if (signIn) {
        command = signIn.command;
        args = signIn.args;
      } else {
        const shell = platform.defaultShell();
        command = shell.command;
        args = shell.args;
      }
    } else {
      const provider = getProvider(terminal.type);
      const specs: McpServerSpec[] = [];
      const prompts: string[] = [];
      const sec = this.wiring.secretsServerSpec?.();
      if (sec?.spec) { specs.push(sec.spec); if (sec.prompt) prompts.push(sec.prompt); }
      const intgSpecs = this.wiring.integrationsSpecs?.() ?? [];
      specs.push(...intgSpecs);
      if (this.isPeerEligible(terminal.type)) {
        specs.push(this.agencyServerSpec(terminalId, terminal.session_id, effectiveSpawnDepth(config), !!sk));
        prompts.push(this.peerPromptFor(terminal));
      }
      this.applyPluginInjection(terminalId, terminal.type, specs, prompts);
      const developerNote = this.wiring.toolsAwareness?.() ?? null;
      const secretsMcp = composeInjection(specs, {
        configPath: this.perTerminalMcpConfigPath(terminalId), prompts, developerNote,
        // The Codex CLI view passes the key-file path through; every other harness the key variable.
        authVar: sk?.keyFile ? 'DISPATCH_AUTH_FILE' : 'DISPATCH_AUTH',
      });
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
        const statusHooks = this.buildStatusHooks(terminalId, terminal.type, specs, !!sk);
        grokHomeDir = statusHooks?.grokHomeDir;
        const branchFrom: string | undefined = typeof config.branchFrom === 'string' ? config.branchFrom : undefined;
        // Honor a per-thread model pick (config.model) for CLI (PTY) threads too, not
        // just structured ones — the New Thread modal offers the picker in both modes.
        // modelFor returns config.model for a plain user thread (no role/agentType).
        this.adoptTranscriptSettings(terminal, config, workDir);
        const model = modelFor(config);
        const effort = terminal.type === 'codex' ? this.codexEffortFor(config, model) : effortFor(config);
        // A provider that names its own session (Grok) gets a fresh uuid here, which is
        // stored once the process is alive. Without it a relaunch after a daemon restart
        // had no id to resume into and silently began a new conversation.
        // A branch of such a provider is named the same way (its fork takes the id).
        if (!terminal.external_id && provider.assignsSessionId) assignedSessionId = randomUUID();
        cmd = terminal.external_id
          ? provider.buildResumeCommand({ externalSessionId: terminal.external_id, workDir, secretsMcp, statusHooks, model, effort })
          : (branchFrom && provider.buildBranchCommand)
            ? provider.buildBranchCommand({ sourceSessionId: branchFrom, workDir, secretsMcp, statusHooks, sessionId: assignedSessionId })
            : provider.buildNewCommand({ workDir, secretsMcp, statusHooks, model, effort, sessionId: assignedSessionId });
      }
      command = cmd.command;
      args = cmd.args;
    }

    // GROK_HOME is how Grok's hooks and MCP servers reach the thread — argv cannot carry
    // them for the top-level command. Everything but `plugins` links back to the real home.
    // The account overlay first, so a thread's own Claude token or Codex home rides every launch
    // (new, resume, relaunch), and the per-process keys below can never be shadowed by it.
    const spawnEnv: Record<string, string> = { ...(this.wiring.accountEnv?.(terminal.type, config) ?? {}), [TERMINAL_ID_ENV_VAR]: terminalId };
    if (grokHomeDir) spawnEnv.GROK_HOME = grokHomeDir;
    // The key travels in the environment of this one process, never in argv and never in the shared
    // default env. The Codex CLI view writes its environment to a snapshot file, so it gets the path
    // of a 0600 key file instead (probe results, Finding 1).
    if (sk) {
      if (sk.keyFile) spawnEnv.DISPATCH_AUTH_FILE = sk.keyFile;
      else spawnEnv.DISPATCH_AUTH = sk.key;
    }
    const pid = this.ptyManager.spawn(terminalId, command, args, workDir, spawnEnv);
    if (sk) this.wiring.threadKeys?.bindPty(terminalId, pid, sk.handle);
    terminalsDb.updatePid(this.db, terminalId, pid);
    // AFTER the spawn, never before: a stored id for a process that failed to start would
    // send the next relaunch chasing a conversation that never existed.
    if (assignedSessionId) terminalsDb.updateExternalId(this.db, terminalId, assignedSessionId);

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
   *   - every claude-code/codex thread gets the Dispatch agency MCP folded in
   *     (peer tools, plus full spawn/steer agency — see isPeerEligible),
   *   - the Overseer persona is injected via --append-system-prompt,
   *   - only typed AGENT threads escalate gated tools (the membrane).
   * When `terminal.external_id` is set it appends `-r <id>` (resume the same claude
   * conversation) and backfills the ring with prior history so the View isn't blank
   * after a daemon restart. Idempotent: a no-op when the thread is already alive.
   */
  /**
   * A coordinator's persona AND its enforcement membrane (coordinatorToolPolicy) are honored ONLY
   * by a coordinator-CAPABLE harness's structured manager (claude-code / codex — see
   * COORDINATOR_CAPABLE_HARNESSES; Grok/OpenCode ACP ignore toolPolicy, and a `shell` never has a
   * membrane at all). Throws for ANY coordinator that is not a capable harness running governed
   * structured transport — otherwise it would spawn ungoverned (a raw PTY with
   * --dangerously-bypass-approvals-and-sandbox, or an ACP thread that never consults the policy).
   *
   * Called from BOTH spawn doors: spawnTerminal (create / relaunch / restore / ws) and
   * spawnStructured itself, because the revive path (ensureStructuredAlive) enters
   * spawnStructured directly — a guard on only one door is no guard (review finding N2).
   */
  private assertCoordinatorGoverned(terminal: terminalsDb.TerminalRow, config: Record<string, any>): void {
    if (config.role !== 'coordinator') return;
    if (COORDINATOR_CAPABLE_HARNESSES.has(terminal.type) && config.transport === 'structured' && this.structuredManagerFor(terminal.type)) return;
    throw new Error(
      `refusing to spawn coordinator ${terminal.id} (${terminal.type}) without a governed coordinator-capable structured transport`,
    );
  }

  /**
   * A model or effort the owner changed INSIDE a thread (`/model`, `/effort`) lives only in the
   * running process. Fold what the transcript shows the thread last ran with into its saved
   * config before a command is built, so every relaunch (CLI <-> Pretty, daemon restart,
   * update) keeps it. Plain Claude user threads with a session to resume only.
   */
  private adoptTranscriptSettings(terminal: terminalsDb.TerminalRow, config: Record<string, any>, workDir: string): void {
    if (!terminal.external_id) return;
    if (config.runner) return; // a headless run is never resumed
    // Claude: the transcript's last lead turn. Codex: the rollout's last turn_context (a `/model`
    // typed in the Codex CLI lands only there). Model only for Codex — its effort is not saved.
    const seen = terminal.type === 'claude-code'
      ? readSessionSettings(workDir, terminal.external_id)
      : terminal.type === 'codex' ? readCodexSessionModel(terminal.external_id) : null;
    const before = { model: config.model, effort: config.effort };
    if (!adoptTranscriptSettingsInto(config, seen)) return;
    // `config` is the spawn's working copy: only the keys that adoption changed are written.
    const adopted: ConfigPatch = {};
    if (config.model !== before.model) adopted.model = config.model;
    if (config.effort !== before.effort) adopted.effort = config.effort;
    try { this.configStore.patch(terminal.id, adopted); } catch { /* best effort */ }
  }

  private spawnStructured(terminal: terminalsDb.TerminalRow, config: Record<string, any>, workDir: string): void {
    this.assertCoordinatorGoverned(terminal, config);
    this.adoptTranscriptSettings(terminal, config, workDir);
    const manager = this.structuredManagerFor(terminal.type);
    if (!manager) throw new Error('structured transport not supported for this provider');
    if (manager.isAlive(terminal.id)) return; // already running — don't double-spawn

    // Mint right before the process starts (this also covers the revive path, ensureStructuredAlive).
    // A Codex Pretty thread keeps one sticky key for its life on this daemon (probe results, Finding 3).
    const sk = this.mintSpawnKey(terminal.id, 'thread', { codexPretty: terminal.type === 'codex' });
    try {
      this.spawnStructuredKeyed(terminal, config, workDir, manager, sk);
    } catch (err) {
      if (sk) this.wiring.threadKeys?.spawnFailed(sk.handle);
      throw err;
    }
  }

  private spawnStructuredKeyed(
    terminal: terminalsDb.TerminalRow,
    config: Record<string, any>,
    workDir: string,
    manager: import('../structured/manager.js').IStructuredManager,
    sk: SpawnKey | null,
  ): void {
    const provider = getProvider(terminal.type);
    // Same secrets/integrations/tools-awareness MCP wiring as a fresh PTY spawn.
    const specs: McpServerSpec[] = [];
    const prompts: string[] = [];
    const sec = this.wiring.secretsServerSpec?.();
    if (sec?.spec) { specs.push(sec.spec); if (sec.prompt) prompts.push(sec.prompt); }
    const intgSpecs = this.wiring.integrationsSpecs?.() ?? [];
    specs.push(...intgSpecs);
    if (this.isPeerEligible(terminal.type)) {
      specs.push(this.agencyServerSpec(terminal.id, terminal.session_id, effectiveSpawnDepth(config), !!sk));
      prompts.push(this.peerPromptFor(terminal));
    }
    this.applyPluginInjection(terminal.id, terminal.type, specs, prompts);
    const developerNote = this.wiring.toolsAwareness?.() ?? null;
    const structuredMcp = composeInjection(specs, {
      configPath: this.perTerminalMcpConfigPath(terminal.id), prompts, developerNote,
      // Codex Pretty: the thread config (a pipe to the app-server) holds the literal key.
      ...(terminal.type === 'codex' && sk ? { codexAuthLiteral: sk.key } : {}),
    });

    // Grok's MCP servers ride a per-thread plugin passed as `--plugin-dir` — the `grok
    // agent` subcommand's TRUSTED plugin scope. NOT via GROK_HOME like the PTY flow: a
    // home-injected plugin loads untrusted, and an untrusted plugin's MCP tools are
    // visible to the model but not callable (verified live). Written with NO hooks: the
    // manager's own turn boundaries drive status, and hook-reported Stop events on top
    // would double-report every turn.
    let grokPluginDir: string | undefined;
    if (terminal.type === 'grok' && this.wiring.statusContext) {
      try {
        const mcpServers = this.mcpEntries(specs, '${DISPATCH_AUTH}');
        const dir = writeGrokHome({
          dir: path.join(this.wiring.statusContext.hooksDir, 'grok-homes', terminal.id),
          realHome: path.join(os.homedir(), '.grok'),
          mcpServers,
        });
        if (dir) grokPluginDir = path.join(dir, 'plugins', 'dispatch');
      } catch { /* best-effort — a thread without injections still runs */ }
    }

    const resumeSessionId = terminal.external_id || undefined;

    // An overseer may write only to its own memory and to this project's shared memory folder
    // (overseer memory scope spec 2026-10-07, Unit 2), and its persona names those exact folders
    // (Unit 3). Without a memory home (an unwired test service) they are computed under
    // os.homedir() — only resolved and named, never written.
    const coordinatorFolders = config.role === 'coordinator' ? this.coordinatorMemoryFoldersFor(terminal, workDir) : null;
    const coordinatorDirs = coordinatorFolders
      ? [coordinatorFolders.own, coordinatorFolders.shared].filter((d): d is string => d !== null)
      : null;
    const persona = systemPromptFor(
      config, terminal.type,
      coordinatorFolders ? { memoryFolders: { own: coordinatorFolders.own, shared: coordinatorFolders.shared } } : {},
    );

    // Resolve the model up front (harness-aware) and persist it into the terminal's config if it
    // wasn't already pinned there — so it survives a daemon-restart resume and is
    // returned to the frontend as part of the terminal row's config. OpenCode always
    // pins a model (its config file must name one): the user's harness-settings default
    // wins over the curated fallback.
    // A poisoned harness-settings default (a Claude tier alias saved into opencode's
    // defaultModel — e.g. by a stale UI or a hand-edited settings row) must never reach
    // resolveSpawnModel as "the" opencode default: it would fall through to undefined there,
    // which is unacceptable for opencode (its config file must name a real model). Filter it
    // out HERE, before the `?? OPENCODE_DEFAULT_MODEL` fallback, so a poisoned setting falls
    // back to the curated default instead.
    const opencodeSettingDefault = readHarnessSettings(this.db).opencode?.defaultModel;
    const opencodeDefault =
      opencodeSettingDefault && !isClaudeTierAlias(opencodeSettingDefault) ? opencodeSettingDefault : OPENCODE_DEFAULT_MODEL;
    const resolvedModel = resolveSpawnModel({
      harness: terminal.type,
      config,
      opencodeDefault,
    });
    if (resolvedModel && !config.model) {
      config.model = resolvedModel;
      this.configStore.patch(terminal.id, { model: resolvedModel });
    }

    let sc: { command: string; args: string[] };
    if (this.wiring.structuredCommandOverride) {
      // Test seam: spawn the fake instead of real claude. Still surface `-r <id>` on
      // resume so the resume path is observable in tests.
      sc = { command: this.wiring.structuredCommandOverride.command, args: [...this.wiring.structuredCommandOverride.args] };
      if (resumeSessionId) sc.args.push('-r', resumeSessionId);
    } else {
      // Coordinators get their native-orchestration tools (Agent/Task/Workflow) stripped at
      // spawn: the CLI auto-approves those tools without a can_use_tool request, so the
      // membrane's coordinatorToolPolicy deny (below) never reaches them. Removal from the
      // toolset is the enforcement; the policy deny remains as a backstop.
      // A Claude overseer loads only its own memory folder (overseer memory scope spec, Unit 1).
      const autoMemoryDirectory = this.overseerMemoryFor(terminal, config, workDir, coordinatorFolders);
      const built = provider.buildStructuredCommand?.({ workDir, secretsMcp: structuredMcp, appendSystemPrompt: persona, resumeSessionId, model: resolvedModel, effort: terminal.type === 'claude-code' ? effortFor(config) : undefined, grokPluginDir, disallowedTools: disallowedToolsFor(config), autoMemoryDirectory });
      if (!built) throw new Error('structured transport not supported for this provider');
      sc = built;
    }

    // On resume, restore prior conversation from the claude transcript JSONL. Claude-only:
    // the Codex manager has no Claude transcript to read — it backfills its own history from
    // `thread/resume`/`thread/read` (see CodexStructuredSessionManager.backfill), driven by
    // the `resumeId` field passed to manager.spawn below (set regardless of harness). Pinned
    // in coordinator-restart.test.ts: a Codex resume carries `resumeId` and no seedEvents,
    // even when a same-named claude transcript exists on disk.
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

    // Daemon-enforced ground rules for the coordinator's own tool use (see coordinator-policy.ts) —
    // consulted by the manager's can_use_tool membrane ahead of the escalate/auto-allow branches.
    // A role-run incarnation (config.role === 'agent' with roleAuthority set — see roles/service.ts
    // fire()) gets the equivalent role-policy.ts membrane instead, keyed to its own authority level.
    // roleAuthority is untyped at this call site (config: Record<string, any>); role-policy.ts
    // itself validates it and fails closed to 'observe' for anything it doesn't recognize, so the
    // `as never` cast here is safe — it defers validation, not skips it.
    // ONE invariant, TWO consumers: a Codex coordinator runs the governed read-only + on-request
    // sandbox (below), and BECAUSE of that every surfaced command approval is a sandbox-escape
    // request the membrane must deny wholesale (commandsEscalate). Keying both off this single const
    // keeps them from drifting apart — if a future change moves a Codex coordinator off read-only,
    // both the sandbox override and the command-deny must change together. The same holds for MCP:
    // an MCP tool runs outside the sandbox, so a sandboxed coordinator may call only Dispatch's own.
    const codexCoordinator = terminal.type === 'codex' && config.role === 'coordinator';
    const toolPolicy =
      coordinatorDirs
        ? // A Claude coordinator has no sandbox — its Bash 'allow' just runs — so it keeps the
          // denylist (commandsEscalate false) and its MCP tools. A Codex coordinator denies every
          // escalated command and every MCP tool but Dispatch's own. Either may write only to its
          // own memory and to this project's shared memory folder (coordinatorDirs, above).
          makeCoordinatorPolicy(coordinatorDirs, codexCoordinator
            ? { commandsEscalate: true, allowedMcpServers: [AGENCY_MCP_SERVER] }
            : { commandsEscalate: false })
        : typeof config.roleAuthority === 'string'
          ? roleToolPolicy(config.roleAuthority as never)
          : undefined;

    // OpenCode's whole injection (model, permission mode, system prompt, MCP servers)
    // rides ONE per-thread config file pointed at via OPENCODE_CONFIG — `opencode acp`
    // takes no flags for any of it. Best-effort like the grok plugin dir: a thread
    // without injections still runs, on OpenCode's own global config.
    let opencodeEnv: Record<string, string> | undefined;
    if (terminal.type === 'opencode' && this.wiring.statusContext) {
      try {
        const mcpServers = this.mcpEntries(specs, '{env:DISPATCH_AUTH}');
        // A model with no tool-capable endpoint (settings/model-capabilities.ts) runs
        // chat-only: every tool off, no MCP, and no peer-tools block in the prompt (it
        // would describe tools the model cannot call). The verdict is pinned in
        // config.toolsDisabled on first sight so a resume never re-decides it; the create
        // route pre-pins it for a picked model, and this is the fallback for a thread
        // created without a pick. A cold cache (null) means "tools on" and is NOT pinned,
        // so the next spawn re-asks once the kicked load has landed.
        let toolsDisabled = typeof config.toolsDisabled === 'boolean' ? config.toolsDisabled : undefined;
        if (toolsDisabled === undefined && resolvedModel) {
          const supports = modelSupportsToolsCached(resolvedModel);
          if (supports !== null) {
            toolsDisabled = !supports;
            config.toolsDisabled = toolsDisabled;
            this.configStore.patch(terminal.id, { toolsDisabled });
          }
        }
        const cfgPath = writeOpencodeConfig({
          dir: path.join(this.wiring.statusContext.hooksDir, 'opencode-homes', terminal.id),
          model: resolvedModel,
          escalate,
          systemPrompt: [persona, toolsDisabled ? undefined : structuredMcp?.systemPrompt].filter(Boolean).join('\n\n') || undefined,
          mcpServers,
          toolsDisabled,
        });
        opencodeEnv = { OPENCODE_CONFIG: cfgPath };
      } catch { /* best-effort — a thread without injections still runs */ }
    }

    const pid = manager.spawn(terminal.id, {
      command: sc.command,
      args: sc.args,
      workDir,
      escalate,
      toolPolicy,
      seedEvents,
      // Codex resumes/pins-model out-of-band over JSON-RPC (Claude encodes both in `args` and
      // ignores these); shared on the interface so this one call drives either manager.
      resumeId: resumeSessionId,
      model: resolvedModel,
      effort: terminal.type === 'codex' ? this.codexEffortFor(config, resolvedModel) : undefined,
      // Named on a system/auth_required event, so the chat can say WHICH login is signed out.
      accountId: terminal.type === 'claude-code' || terminal.type === 'codex'
        ? (typeof config.accountId === 'string' && config.accountId ? config.accountId : this.wiring.accountDirectory?.defaultId(terminal.type) ?? 'cli')
        : undefined,
      // Codex delivers this via thread/start's `developerInstructions` (see codex-manager.ts) — the
      // ONLY per-thread prompt channel it has, so it must carry the persona AND the peer/tools
      // block (structuredMcp.systemPrompt: roster, own id, secrets/tools note), exactly like the
      // OpenCode join above. A per-thread developerInstructions also supersedes the app-server's
      // global `-c developer_instructions` note, so leaving the block out would drop it. Only the
      // Codex manager reads this field; Claude/Grok/OpenCode get theirs via argv/config paths.
      systemPrompt: [persona, structuredMcp?.systemPrompt].filter(Boolean).join('\n\n') || undefined,
      // A codex COORDINATOR must run `on-request` + `read-only` (NOT the manager's default
      // `workspace-write`) so the Task 5 enforcement membrane actually fires: under
      // `workspace-write`, an in-workspace repo write / `git commit` / `git push` runs WITHOUT
      // ever surfacing an approval, so handleApproval's toolPolicy gate (coordinatorToolPolicy)
      // never sees exactly the actions it must deny. Read-only + on-request instead surfaces
      // EVERY write/command needing write or network as an approval for the policy to gate —
      // repo writes and git commit/push get denied, and its own memory writes get allowed
      // (toolPolicy above is built per-harness via makeCoordinatorPolicy(coordinatorWriteDirs(…)),
      // so a codex coordinator writes to ~/.codex/dispatch-coordinator and the project's shared
      // Claude memory folder — Task 7, overseer memory scope Unit 2).
      // Every other codex thread (agents, role runs) — and every non-codex harness, which
      // ignores these fields entirely — keeps today's manager-construction defaults.
      ...(codexCoordinator
        ? { approvalPolicy: 'on-request' as const, sandbox: 'read-only' as const }
        : {}),
      // Codex: every Pretty thread shares ONE app-server, whose argv/env belong to whichever
      // thread spawned it first — so nothing thread-specific may ride them (M3). The thread's own
      // MCP servers (its `dispatch` identity) and its terminal id for shell commands (the
      // browser-auth shim) ride its thread/start + thread/resume `config` instead.
      ...(terminal.type === 'codex'
        ? {
            threadConfig: {
              ...(structuredMcp?.codexThreadConfig ?? {}),
              [`shell_environment_policy.set.${TERMINAL_ID_ENV_VAR}`]: terminal.id,
              // The thread's shell commands (the browser-auth shim) carry its own key (probe results).
              ...(sk ? { 'shell_environment_policy.set.DISPATCH_AUTH': sk.key } : {}),
            },
          }
        : {}),
      // Codex keeps {} (the shared app-server env must hold nothing per thread); every other
      // harness gets its own key in the env of its own process.
      // Codex keeps {} (the shared app-server env must hold nothing per thread), so a Codex Pretty
      // thread always runs on the CLI login; an added Codex account is for CLI-mode threads.
      env: terminal.type === 'codex'
        ? {}
        : { ...(this.wiring.accountEnv?.(terminal.type, config) ?? {}), [TERMINAL_ID_ENV_VAR]: terminal.id, ...(sk ? { DISPATCH_AUTH: sk.key } : {}), ...(opencodeEnv ?? {}) },
    });
    if (sk) this.wiring.threadKeys?.bindStructured(terminal.id, sk.handle);
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
      this.lastSpawnError.delete(terminalId);
      return manager.isAlive(terminalId);
    } catch (err) {
      const cause = redactKeys(err instanceof Error ? clientMessage(err) : String(err)); // a system error's text names folders
      this.lastSpawnError.set(terminalId, cause);
      console.error(`[structured] thread ${terminalId} could not start: ${cause}`);
      return false;
    }
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
}
