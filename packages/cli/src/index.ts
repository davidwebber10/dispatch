#!/usr/bin/env node
import { createRequire } from 'module';
import type { DaemonController, DaemonInstallOptions } from 'dispatch-server/platform';

const require = createRequire(import.meta.url);

export interface Ctx {
  daemon: DaemonController;
  port: number;
  nodePath?: string;
  entry?: string;
  repoRoot?: string;
  logDir?: string;
  env?: Record<string, string>;
}

function buildInstallOpts(ctx: Ctx): DaemonInstallOptions {
  return {
    port: ctx.port,
    nodePath: ctx.nodePath ?? process.execPath,
    entry: ctx.entry ?? '',
    repoRoot: ctx.repoRoot ?? process.cwd(),
    logDir: ctx.logDir ?? '',
    env: ctx.env ?? {},
  };
}

export function runCommand(argv: string[], ctx: Ctx): void {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'install':
      ctx.daemon.install(buildInstallOpts(ctx));
      return;
    case 'uninstall':
      ctx.daemon.uninstall();
      return;
    case 'start':
      ctx.daemon.start();
      return;
    case 'stop':
      ctx.daemon.stop();
      return;
    case 'restart':
      ctx.daemon.restart();
      return;
    case 'status': {
      const s = ctx.daemon.status();
      console.log(s.loaded ? `loaded yes${s.pid ? ` (pid ${s.pid})` : ''}` : 'loaded no');
      return;
    }
    case 'build':
      cmdBuild();
      return;
    case 'update':
      cmdUpdate(ctx);
      return;
    case 'run':
      cmdRun(ctx);
      return;
    case 'logs':
      cmdLogs(ctx, rest);
      return;
    default:
      throw new Error(
        `usage: dispatch <build|install|uninstall|start|stop|restart|status|update|run|logs>`,
      );
  }
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { execFileSync, spawnSync } = require('child_process') as typeof import('child_process');

function cmdBuild(): void {
  execFileSync('pnpm', ['-r', 'run', 'build'], { stdio: 'inherit' });
}

function cmdUpdate(ctx: Ctx): void {
  execFileSync('git', ['pull', '--ff-only'], { stdio: 'inherit' });
  cmdBuild();
  ctx.daemon.restart();
}

function cmdRun(ctx: Ctx): void {
  const env = { ...process.env, PORT: String(ctx.port), ...(ctx.env ?? {}) };
  spawnSync(ctx.nodePath ?? process.execPath, [ctx.entry ?? ''], { stdio: 'inherit', env });
}

function cmdLogs(ctx: Ctx, args: string[]): void {
  const logFile = `${ctx.logDir ?? ''}/dispatch.out.log`;
  const follow = args.includes('-f');
  spawnSync('tail', follow ? ['-f', logFile] : ['-n', '200', logFile], { stdio: 'inherit' });
}

// Real entry point — only runs when this file is executed directly
async function main(): Promise<void> {
  const { fileURLToPath } = await import('url');
  const { dirname, resolve } = await import('path');
  const { platform } = await import('dispatch-server/platform');

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // dist/index.js is at packages/cli/dist/index.js → go up 3 levels to repo root
  const repoRoot = resolve(__dirname, '..', '..', '..');
  const entry = resolve(repoRoot, 'packages', 'core', 'dist', 'server.js');
  const logDir = platform.logDir();
  const port = Number(process.env.PORT ?? 3456);

  const ctx: Ctx = {
    daemon: platform.daemon,
    port,
    nodePath: process.execPath,
    entry,
    repoRoot,
    logDir,
    env: {
      PORT: String(port),
      ...(process.env.DISPATCH_SERVERS ? { DISPATCH_SERVERS: process.env.DISPATCH_SERVERS } : {}),
    },
  };

  try {
    runCommand(process.argv.slice(2), ctx);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exit(1);
  }
}

// Detect direct execution in ESM
const isMain = (() => {
  try {
    const { fileURLToPath } = require('url') as typeof import('url');
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
