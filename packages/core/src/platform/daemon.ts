export interface DaemonInstallOptions {
  port: number;
  nodePath: string;     // absolute path to node
  entry: string;        // absolute path to packages/core/dist/server.js
  repoRoot: string;
  env: Record<string, string>;
  logDir: string;
}

export interface DaemonStatus {
  loaded: boolean;
  pid?: number;
}

export interface DaemonController {
  install(opts: DaemonInstallOptions): void;
  uninstall(): void;
  start(): void;
  stop(): void;
  restart(): void;
  status(): DaemonStatus;
}
