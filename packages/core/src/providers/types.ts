/**
 * Optional per-spawn injection that wires the Doppler secrets MCP server into the
 * launched CLI so agents can add/retrieve secrets. `claudeConfigPath` is the path to
 * a generated `--mcp-config` file; `codexArgs` are `-c` overrides registering the
 * server; `systemPrompt` is a standing instruction telling the agent to use Doppler
 * for secrets (appended to Claude's system prompt). All are no-ops when Doppler is
 * not connected.
 */
export interface SecretsMcpInjection {
  claudeConfigPath?: string | null;
  codexArgs?: string[];
  systemPrompt?: string | null;
}

/**
 * Inputs a provider needs to wire a spawned CLI to phone home with lifecycle
 * events. The terminal id is the URL segment events POST to:
 * `${serverUrl}/api/events/<provider>/<terminalId>`.
 */
export interface StatusHooksContext {
  serverUrl: string;
  terminalId: string;
  /** Absolute path to the Codex notify helper script (POSTs the notify payload). */
  codexHelperPath: string;
  /** Absolute path to the Grok hook helper script (POSTs the hook payload from stdin). */
  grokHelperPath?: string;
}

/**
 * Provider-shaped plan for status hooks. Claude returns a settings OBJECT (the
 * caller serializes + writes it and passes the path via `--settings`); Codex
 * returns the extra `-c notify=[...]` args. Exactly one field is populated.
 */
export interface StatusHooksPlan {
  claudeSettings?: Record<string, unknown>;
  codexArgs?: string[];
  /**
   * Grok reads hooks from a plugin directory rather than a settings file or argv, and the
   * SAME directory also carries its MCP servers — so the plan hands back the hooks JSON and
   * the caller merges it into the one plugin dir it writes for the spawn.
   */
  grokHooks?: { eventsUrl: string; helperPath: string };
}

/** Resolved injection passed into the build* commands (after IO is done). */
export interface StatusHooksInjection {
  /** Path passed to `claude --settings <path>`. */
  claudeSettingsPath?: string;
  /** Extra `-c notify=[...]` args spliced before the codex subcommand. */
  codexNotifyArgs?: string[];
  /** Per-thread GROK_HOME, exported into the spawn env. Holds this thread's plugin. */
  grokHomeDir?: string;
}

export interface SessionProvider {
  name: string;
  displayName: string;
  statusStrategy?: 'hooks' | 'pty-timing';
  /**
   * True when this CLI lets the caller NAME the session up front, rather than making us
   * discover the id it chose after the fact.
   *
   * The discover path (`captureSessionId`) is inherently lossy: it polls the filesystem,
   * it can miss, and Claude's version needs an ambiguity heuristic for when two sessions
   * are born in the same window. A provider that accepts an id has none of those problems,
   * so the caller generates one, passes it to `buildNewCommand` as `sessionId`, and stores
   * it as soon as the process is alive.
   */
  assignsSessionId?: boolean;
  buildNewCommand(args: { workDir: string; prompt?: string; secretsMcp?: SecretsMcpInjection; statusHooks?: StatusHooksInjection; model?: string; sessionId?: string }): { command: string; args: string[] };
  buildResumeCommand(args: { externalSessionId: string; workDir: string; secretsMcp?: SecretsMcpInjection; statusHooks?: StatusHooksInjection; model?: string }): { command: string; args: string[] };
  /**
   * Build the command to BRANCH (fork) an existing conversation: resume the
   * source session but fork it into a NEW session id, leaving the original
   * untouched. Undefined for providers that don't support forking.
   */
  buildBranchCommand?(args: { sourceSessionId: string; workDir: string; secretsMcp?: SecretsMcpInjection; statusHooks?: StatusHooksInjection }): { command: string; args: string[] };
  /**
   * Build the command for an autonomous "runner" launch: the provider is run
   * headlessly with the prompt so it executes the agentic loop to completion
   * and the process EXITS when done (a clean completion signal), rather than
   * dropping into an interactive REPL. Used by scheduled/triggered agent runs.
   */
  buildRunnerCommand(args: { workDir: string; prompt: string; secretsMcp?: SecretsMcpInjection }): { command: string; args: string[] };
  /** Shape the provider-specific status-hooks plan, or undefined to opt out. */
  buildStatusHooks?(ctx: StatusHooksContext): StatusHooksPlan | undefined;
  /**
   * After a fresh session has been spawned, attempt to discover the external
   * session ID the provider assigned. Polls until the deadline is reached.
   * Returns null if the ID could not be determined.
   */
  captureSessionId?(args: { workDir: string; spawnTime: number; deadlineMs: number }): Promise<string | null>;
  /**
   * Build the command for a structured session transport using stream-json control
   * protocol. Returns the command with stream-json flags and optional MCP injection.
   * Permissions come from the session manager's auto-allow loop, not flags.
   * `appendSystemPrompt` injects an additional `--append-system-prompt <text>` (e.g.
   * a coordinator/typed-agent persona) on top of any secrets system prompt.
   * `resumeSessionId` appends `-r <id>` to resume an existing claude conversation
   * (used to revive a structured thread after a daemon restart) while keeping all
   * the structured stream-json flags + persona + MCP wiring.
   * `model` pins the CLI model for this thread (e.g. a per-agent-type tier) via
   * `--model <alias>`; omitted flag means the CLI's default model.
   * `grokPluginDir` (Grok only) is the per-thread plugin directory carrying the MCP
   * servers, passed as `--plugin-dir` on the `grok agent` subcommand — the TRUSTED plugin
   * scope. The same plugin under GROK_HOME loads untrusted, which leaves its MCP tools
   * visible but uncallable (verified live).
   */
  buildStructuredCommand?(args: { workDir: string; secretsMcp?: SecretsMcpInjection; appendSystemPrompt?: string; resumeSessionId?: string; model?: string; grokPluginDir?: string }): { command: string; args: string[] };
}
