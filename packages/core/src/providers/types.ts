/**
 * Optional per-spawn injection that wires the Doppler secrets MCP server into the
 * launched CLI so agents can add/retrieve secrets. `claudeConfigPath` is the path to
 * a generated `--mcp-config` file; `codexArgs` are `-c` overrides registering the
 * server. Both are no-ops when Doppler is not connected.
 */
export interface SecretsMcpInjection {
  claudeConfigPath?: string | null;
  codexArgs?: string[];
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
}

/**
 * Provider-shaped plan for status hooks. Claude returns a settings OBJECT (the
 * caller serializes + writes it and passes the path via `--settings`); Codex
 * returns the extra `-c notify=[...]` args. Exactly one field is populated.
 */
export interface StatusHooksPlan {
  claudeSettings?: Record<string, unknown>;
  codexArgs?: string[];
}

/** Resolved injection passed into the build* commands (after IO is done). */
export interface StatusHooksInjection {
  /** Path passed to `claude --settings <path>`. */
  claudeSettingsPath?: string;
  /** Extra `-c notify=[...]` args spliced before the codex subcommand. */
  codexNotifyArgs?: string[];
}

export interface SessionProvider {
  name: string;
  displayName: string;
  statusStrategy?: 'hooks' | 'pty-timing';
  buildNewCommand(args: { workDir: string; prompt?: string; secretsMcp?: SecretsMcpInjection; statusHooks?: StatusHooksInjection }): { command: string; args: string[] };
  buildResumeCommand(args: { externalSessionId: string; workDir: string; secretsMcp?: SecretsMcpInjection; statusHooks?: StatusHooksInjection }): { command: string; args: string[] };
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
}
