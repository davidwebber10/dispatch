export interface SessionProvider {
  name: string;
  displayName: string;
  statusStrategy?: 'hooks' | 'pty-timing';
  buildNewCommand(args: { workDir: string; prompt?: string }): { command: string; args: string[] };
  buildResumeCommand(args: { externalSessionId: string; workDir: string }): { command: string; args: string[] };
  /**
   * Build the command for an autonomous "runner" launch: the provider is run
   * headlessly with the prompt so it executes the agentic loop to completion
   * and the process EXITS when done (a clean completion signal), rather than
   * dropping into an interactive REPL. Used by scheduled/triggered agent runs.
   */
  buildRunnerCommand(args: { workDir: string; prompt: string }): { command: string; args: string[] };
  buildHooksConfig?(args: { serverUrl: string; sessionId: string }): Record<string, unknown>;
  /**
   * After a fresh session has been spawned, attempt to discover the external
   * session ID the provider assigned. Polls until the deadline is reached.
   * Returns null if the ID could not be determined.
   */
  captureSessionId?(args: { workDir: string; spawnTime: number; deadlineMs: number }): Promise<string | null>;
}
