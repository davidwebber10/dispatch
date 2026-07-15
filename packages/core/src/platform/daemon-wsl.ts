import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import type { DaemonController, DaemonInstallOptions } from './daemon.js';

export interface WslDaemonDeps {
  dataDir(): string;
  execFileSync(cmd: string, args: string[]): string;
  readFile(p: string): string;
  writeFile(p: string, s: string): void;
  unlink(p: string): void;
  spawnDetached(cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }): void;
  kill(pid: number, sig: number | NodeJS.Signals): void;
  env: NodeJS.ProcessEnv;
}

const TASK = 'Dispatch';

/** fs/child_process-backed deps for the real WSL runtime. */
export const defaultWslDaemonDeps: WslDaemonDeps = {
  dataDir: () => path.join(os.homedir(), '.dispatch'),
  execFileSync: (cmd, args) => execFileSync(cmd, args, { encoding: 'utf-8' }),
  readFile: (p) => fs.readFileSync(p, 'utf-8'),
  writeFile: (p, s) => fs.writeFileSync(p, s),
  unlink: (p) => fs.unlinkSync(p),
  spawnDetached: (cmd, args, o) => {
    spawn(cmd, args, { detached: true, stdio: 'ignore', ...(o?.env ? { env: o.env } : {}) }).unref();
  },
  kill: (pid, sig) => process.kill(pid, sig),
  env: process.env,
};

export function createWslDaemon(d: WslDaemonDeps): DaemonController {
  const pidFile = () => path.join(d.dataDir(), 'daemon.pid');
  const optsFile = () => path.join(d.dataDir(), 'daemon.json');
  const readPid = (): number | null => {
    try { const n = parseInt(d.readFile(pidFile()).trim(), 10); return Number.isInteger(n) ? n : null; }
    catch { return null; }
  };
  const alive = (pid: number) => { try { d.kill(pid, 0); return true; } catch { return false; } };
  // The basename we expect to see in a live pid's /proc/<pid>/cmdline. Falls back to the
  // literal 'server.js' when daemon.json can't be read, so identity checks still work even
  // if the install record is missing or corrupt.
  const entryBasename = (): string => {
    try {
      const opts = JSON.parse(d.readFile(optsFile())) as DaemonInstallOptions;
      return path.basename(opts.entry);
    } catch { return 'server.js'; }
  };
  // Guards against SIGTERM-ing a recycled pid: the recorded pid may have exited and been
  // reused by an unrelated process by the time we act on it. If we can't read the cmdline
  // at all (proc gone, or a non-Linux test environment), treat the pid as NOT ours.
  const ownsPid = (pid: number, basename: string): boolean => {
    try {
      const cmdline = d.readFile(`/proc/${pid}/cmdline`);
      return cmdline.includes(basename);
    } catch { return false; }
  };

  return {
    install(opts: DaemonInstallOptions) {
      d.writeFile(optsFile(), JSON.stringify(opts));
      const distro = d.env.WSL_DISTRO_NAME ?? 'Ubuntu';
      // The wsl.exe process anchors the distro VM's lifetime AND the daemon's interop context.
      const tr = `wsl.exe -d "${distro}" --exec "${opts.repoRoot}/bin/dispatch" daemon-run`;
      d.execFileSync('schtasks.exe', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', TASK, '/TR', tr]);
      d.execFileSync('schtasks.exe', ['/Run', '/TN', TASK]);
    },
    uninstall() {
      d.execFileSync('schtasks.exe', ['/Delete', '/F', '/TN', TASK]);
      // Best-effort: state files may already be gone, and that's fine.
      try { d.unlink(optsFile()); } catch { /* ignore */ }
      try { d.unlink(pidFile()); } catch { /* ignore */ }
    },
    start() { d.execFileSync('schtasks.exe', ['/Run', '/TN', TASK]); },
    stop() {
      const pid = readPid();
      if (!pid) return;
      if (!ownsPid(pid, entryBasename())) return; // unverifiable/recycled pid: treat as not running
      d.kill(pid, 'SIGTERM');
    },
    restart() {
      const pid = readPid();
      if (pid && ownsPid(pid, entryBasename())) {
        d.kill(pid, 'SIGTERM');
        const until = Date.now() + 5000;
        // Bounded busy-loop rather than a single blocking wait: on the main thread
        // Atomics.wait is fine for a fixed sleep, but polling alive() in between lets
        // us stop as soon as the process actually exits instead of always waiting the
        // full interval.
        for (let i = 0; i < 50 && alive(pid) && Date.now() < until; i++) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        }
        if (alive(pid)) {
          throw new Error(`previous daemon (pid ${pid}) did not exit within 5s; refusing to spawn a second instance`);
        }
      }
      // If the recorded pid wasn't verifiably ours, we deliberately did not kill it above —
      // it's unsafe to signal a pid we can't identify. We still proceed to spawn the new
      // instance; the persisted install options (env/port) always win via the PORT override.
      const opts = JSON.parse(d.readFile(optsFile())) as DaemonInstallOptions;
      d.spawnDetached(opts.nodePath, [opts.entry], { env: { ...d.env, ...opts.env, PORT: String(opts.port) } });
    },
    status() { const pid = readPid(); return pid && alive(pid) ? { loaded: true, pid } : { loaded: false }; },
  };
}
