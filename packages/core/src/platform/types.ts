export interface ShellSpec {
  command: string;
  args: string[];
}

export interface BrowserShimOptions {
  dataDir: string;
  serverUrl: string;
}

// darwin returns BROWSER/GH_BROWSER/DISPATCH_SERVER_URL/PATH; win32 returns {}.
export type BrowserShimEnv = Record<string, string>;

export interface Platform {
  /** process.platform of the active implementation. */
  readonly id: NodeJS.Platform;
  /** Shell for a plain `shell` terminal. */
  defaultShell(): ShellSpec;
  /** Login-shell PATH (macOS GUI-launch fix); undefined when not needed (Windows). */
  resolveLoginPath(): string | undefined;
  /** Data dir (SQLite + runtime). */
  dataDir(): string;
  /** Log dir. */
  logDir(): string;
  /** Absolute path to an executable on PATH, or null. Resolves .cmd/Node shims on Windows. */
  resolveCommand(name: string): string | null;
  /** All live process ids (used to reap orphaned PTYs). */
  listProcessIds(): number[];
  /** The `~/.claude/projects/<encoded>` dir for a working directory. */
  claudeProjectDir(workDir: string): string;
  /** Installs the browser/OAuth capture shim; returns env to inject. {} when unsupported. */
  installBrowserShim(opts: BrowserShimOptions): BrowserShimEnv;
}
