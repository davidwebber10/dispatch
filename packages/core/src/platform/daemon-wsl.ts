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
  spawnDetached(cmd: string, args: string[]): void;
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
  spawnDetached: (cmd, args) => { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); },
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

  return {
    install(opts: DaemonInstallOptions) {
      d.writeFile(optsFile(), JSON.stringify(opts));
      const distro = d.env.WSL_DISTRO_NAME ?? 'Ubuntu';
      // The wsl.exe process anchors the distro VM's lifetime AND the daemon's interop context.
      const tr = `wsl.exe -d ${distro} --exec ${opts.repoRoot}/bin/dispatch daemon-run`;
      d.execFileSync('schtasks.exe', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', TASK, '/TR', tr]);
      d.execFileSync('schtasks.exe', ['/Run', '/TN', TASK]);
    },
    uninstall() { d.execFileSync('schtasks.exe', ['/Delete', '/F', '/TN', TASK]); },
    start() { d.execFileSync('schtasks.exe', ['/Run', '/TN', TASK]); },
    stop() { const pid = readPid(); if (pid) d.kill(pid, 'SIGTERM'); },
    restart() {
      const pid = readPid();
      if (pid) {
        d.kill(pid, 'SIGTERM');
        const until = Date.now() + 5000;
        // Bounded busy-loop rather than a single blocking wait: on the main thread
        // Atomics.wait is fine for a fixed sleep, but polling alive() in between lets
        // us stop as soon as the process actually exits instead of always waiting the
        // full interval.
        for (let i = 0; i < 50 && alive(pid) && Date.now() < until; i++) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        }
      }
      const opts = JSON.parse(d.readFile(optsFile())) as DaemonInstallOptions;
      d.spawnDetached(opts.nodePath, [opts.entry]);
    },
    status() { const pid = readPid(); return pid && alive(pid) ? { loaded: true, pid } : { loaded: false }; },
  };
}
