export interface SessionProvider {
  name: string;
  displayName: string;
  statusStrategy?: 'hooks' | 'pty-timing';
  buildNewCommand(args: { workDir: string; prompt?: string }): { command: string; args: string[] };
  buildResumeCommand(args: { externalSessionId: string; workDir: string }): { command: string; args: string[] };
  buildHooksConfig?(args: { serverUrl: string; sessionId: string }): Record<string, unknown>;
  /**
   * After a fresh session has been spawned, attempt to discover the external
   * session ID the provider assigned. Polls until the deadline is reached.
   * Returns null if the ID could not be determined.
   */
  captureSessionId?(args: { workDir: string; spawnTime: number; deadlineMs: number }): Promise<string | null>;
}
