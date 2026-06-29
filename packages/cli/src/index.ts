#!/usr/bin/env node
import { createRequire } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
  /** The platform identifier — used to conditionally pass { shell: true } on win32. */
  platformId?: NodeJS.Platform;
  /** Optional injectable HTTP probe for testability. Defaults to a spawnSync-based check. */
  probe?: (port: number) => boolean;
  /**
   * Optional injectable runner for the bundled-tools CLI (test seam). Receives the
   * passthrough argv after `tools`. Defaults to spawning `node <coreDist>/tools/cli.js`.
   */
  toolsRunner?: (args: string[]) => void;
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
      console.log(probeHttp(ctx.port, ctx.probe));
      return;
    }
    case 'build':
      cmdBuild(ctx);
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
    case 'tools':
      cmdTools(ctx, rest);
      return;
    default:
      throw new Error(
        `usage: dispatch <build|install|uninstall|start|stop|restart|status|update|run|logs|tools>`,
      );
  }
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { execFileSync, spawnSync } = require('child_process') as typeof import('child_process');

/**
 * Probe whether the Dispatch HTTP server is reachable on the given port.
 * If `probe` is provided (e.g. in tests), it is called directly.
 * Otherwise a child `node` process issues the HTTP request so this stays sync.
 */
export function probeHttp(port: number, probe?: (port: number) => boolean): string {
  const url = `http://localhost:${port}`;
  let reachable: boolean;
  if (probe !== undefined) {
    reachable = probe(port);
  } else {
    const script =
      `require('http').get('${url}/api/sessions',r=>{process.exit(0)}).on('error',()=>process.exit(1))`;
    const result = spawnSync(process.execPath, ['-e', script], { timeout: 1500 });
    reachable = result.status === 0;
  }
  return reachable
    ? `HTTP: reachable at ${url}`
    : `HTTP: not responding on ${url}`;
}

/**
 * Resolve the path to the bundled-tools CLI (packages/core/dist/tools/cli.js),
 * derived from the same repo root the CLI computes for `entry`/the server path.
 */
function toolsCliPath(ctx: Ctx): string {
  const repoRoot = ctx.repoRoot ?? process.cwd();
  return path.join(repoRoot, 'packages', 'core', 'dist', 'tools', 'cli.js');
}

function cmdBuild(ctx: Ctx): void {
  // On win32 pnpm/git are .cmd shims that execFile cannot launch directly without
  // shell: true. On macOS/Linux the binaries are real executables — no shell needed.
  const shellOpt = ctx.platformId === 'win32' ? { shell: true } : {};
  execFileSync('pnpm', ['-r', 'run', 'build'], { stdio: 'inherit', ...shellOpt });
  // Best-effort: install the bundled CLI tools after a successful build. Mirrors the
  // old bash `node .../tools/cli.js install || warn` — never fail the build on this.
  try {
    execFileSync(ctx.nodePath ?? process.execPath, [toolsCliPath(ctx), 'install'], {
      stdio: 'inherit',
    });
  } catch {
    console.error('Some tools failed to install (continuing).');
  }
}

/**
 * `dispatch tools <args>` — delegate to the bundled-tools CLI, inheriting stdio so
 * its output shows. On win32 use the same shell:true pattern as pnpm/git for safety.
 */
function cmdTools(ctx: Ctx, args: string[]): void {
  if (ctx.toolsRunner !== undefined) {
    ctx.toolsRunner(args);
    return;
  }
  const shellOpt = ctx.platformId === 'win32' ? { shell: true } : {};
  const node = ctx.nodePath ?? process.execPath;
  spawnSync(node, [toolsCliPath(ctx), ...args], { stdio: 'inherit', ...shellOpt });
}

function cmdUpdate(ctx: Ctx): void {
  const shellOpt = ctx.platformId === 'win32' ? { shell: true } : {};
  execFileSync('git', ['pull', '--ff-only'], { stdio: 'inherit', ...shellOpt });
  cmdBuild(ctx);
  ctx.daemon.restart();
}

function cmdRun(ctx: Ctx): void {
  const env = { ...process.env, PORT: String(ctx.port), ...(ctx.env ?? {}) };
  spawnSync(ctx.nodePath ?? process.execPath, [ctx.entry ?? ''], { stdio: 'inherit', env });
}

/** Returns the last `n` lines of `content`. Pure helper — no I/O, cross-platform. */
export function lastLines(content: string, n: number): string {
  if (n <= 0) return '';
  // Normalise a single trailing newline so it doesn't count as an extra empty line.
  const normalised = content.endsWith('\n') ? content.slice(0, -1) : content;
  if (normalised === '') return '';
  const lines = normalised.split('\n');
  return lines.slice(-n).join('\n');
}

function cmdLogs(ctx: Ctx, args: string[]): void {
  const logDir = ctx.logDir ?? '';
  const outFile = path.join(logDir, 'dispatch.out.log');
  // stderr is separate on macOS (plist StandardErrorPath); on win32 the task XML
  // redirects everything to out.log so err.log won't exist — handle gracefully.
  const errFile = path.join(logDir, 'dispatch.err.log');
  const follow = args.includes('-f');

  const outExists = fs.existsSync(outFile);
  const errExists = fs.existsSync(errFile);

  if (!outExists && !errExists) {
    console.log('no logs yet');
    return;
  }

  if (!follow) {
    if (outExists) {
      const content = fs.readFileSync(outFile, 'utf-8');
      const out = lastLines(content, 200);
      if (out) {
        process.stdout.write('==> dispatch.out.log <==\n');
        process.stdout.write(out + '\n');
      }
    }
    if (errExists) {
      const content = fs.readFileSync(errFile, 'utf-8');
      const out = lastLines(content, 200);
      if (out) {
        process.stdout.write('==> dispatch.err.log <==\n');
        process.stdout.write(out + '\n');
      }
    }
    return;
  }

  // Follow mode: print last 200 lines of each file then stream appended bytes.
  const watchedFiles: string[] = [];

  const watchFile = (filePath: string, label: string) => {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf-8');
    const out = lastLines(content, 200);
    if (out) {
      process.stdout.write(`==> ${label} <==\n`);
      process.stdout.write(out + '\n');
    }
    let offset = fs.statSync(filePath).size;
    watchedFiles.push(filePath);
    fs.watchFile(filePath, { interval: 250 }, (curr) => {
      if (curr.size <= offset) return; // truncation or no change
      // Loop until no more bytes to read — a single readSync may not capture all
      // appended bytes when the write is large (short-read guard).
      const fd = fs.openSync(filePath, 'r');
      let pos = offset;
      while (pos < curr.size) {
        const chunkSize = curr.size - pos;
        const buf = Buffer.alloc(chunkSize);
        const bytesRead = fs.readSync(fd, buf, 0, chunkSize, pos);
        if (bytesRead === 0) break;
        process.stdout.write(buf.subarray(0, bytesRead));
        pos += bytesRead;
      }
      fs.closeSync(fd);
      offset = curr.size;
    });
  };

  watchFile(outFile, 'dispatch.out.log');
  watchFile(errFile, 'dispatch.err.log');

  // Clean up watchers on SIGINT (Ctrl-C) so the process exits promptly.
  process.once('SIGINT', () => {
    for (const f of watchedFiles) fs.unwatchFile(f);
    process.exit(0);
  });
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

  // #1: Bake PATH into the plist env on darwin so spawned processes have a good
  // PATH at process-creation time (belt-and-suspenders with resolveLoginPath()).
  // Mirrors write_plist() in the old bash script:
  //   path_val="$node_dir:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin"
  // Do NOT set PATH on win32 — the logon task already inherits the registry PATH.
  const darwinPathEnv: Record<string, string> = {};
  if (platform.id === 'darwin') {
    const nodeDir = path.dirname(process.execPath);
    const home = os.homedir();
    const curatedPath =
      `${nodeDir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${home}/.local/bin`;
    darwinPathEnv.PATH = platform.resolveLoginPath() ?? curatedPath;
  }

  // #2: Bake DISPATCH_WEB_DIST so the server always finds the built web assets
  // without relying on its own relative-path fallback.
  const webDist = resolve(repoRoot, 'packages', 'web', 'dist');

  const ctx: Ctx = {
    daemon: platform.daemon,
    port,
    nodePath: process.execPath,
    entry,
    repoRoot,
    logDir,
    platformId: platform.id,
    env: {
      PORT: String(port),
      DISPATCH_WEB_DIST: webDist,
      ...darwinPathEnv,
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
