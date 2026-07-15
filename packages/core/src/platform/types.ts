import type { DaemonController } from './daemon.js';
import type { RevealClient } from '../files/reveal.js';

export interface ShellSpec {
  command: string;
  args: string[];
}

export interface BrowserShimOptions {
  dataDir: string;
  serverUrl: string;
}

// darwin and linux install the posix browser shim and return BROWSER/GH_BROWSER/DISPATCH_SERVER_URL/PATH.
export type BrowserShimEnv = Record<string, string>;

export interface TailscaleStatus {
  ip: string | null;
  hostname: string | null;
  online: boolean;
}

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
  /** Manages the background server daemon for this platform. */
  readonly daemon: DaemonController;
  /** 'macos' | 'wsl' | 'linux' — the host-integration flavor (finer-grained than `id`). */
  readonly flavor: 'macos' | 'wsl' | 'linux';
  /** Name of the native file manager to reveal files in, or null when Reveal is never offered. */
  readonly fileManagerName: string | null;
  /** Opens the native file manager with the given absolute paths selected. */
  revealInFileManager(absPaths: string[]): Promise<void>;
  /** True when the request client is genuinely on this machine (not behind a same-host proxy). */
  isLocalClient(client: RevealClient): boolean;
  /** Platform key used to select prebuilt tool binaries, e.g. 'darwin-arm64' | 'linux-x64'. */
  toolPlatformKey(): string;
  /** Current Tailscale status, or the null shape when Tailscale is absent/unreachable. */
  tailscaleStatus(): Promise<TailscaleStatus>;
}
