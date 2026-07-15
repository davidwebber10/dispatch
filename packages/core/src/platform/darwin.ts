import os from 'os';
import path from 'path';
import { execFile, execFileSync } from 'child_process';
import type { Platform, TailscaleStatus } from './types.js';
import { encodeClaudeProjectDir } from './encode.js';
import { installBrowserShim } from '../auth/shim.js';
import { createDarwinDaemon } from './daemon-darwin.js';
import { isLoopbackAddress, isLoopbackHost } from '../files/reveal.js';

/** Absolute path to the Tailscale CLI bundled inside the macOS app. */
const TAILSCALE_BIN = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

export const darwin: Platform = {
  id: 'darwin',
  defaultShell: () => ({ command: process.env.SHELL || '/bin/zsh', args: [] }),
  resolveLoginPath: () => {
    try {
      const shell = process.env.SHELL || '/bin/zsh';
      const out = execFileSync(
        shell,
        ['-ilc', 'echo -n "__DISPATCH_PATH_START__${PATH}__DISPATCH_PATH_END__"'],
        { encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const m = String(out).match(/__DISPATCH_PATH_START__(.*?)__DISPATCH_PATH_END__/s);
      const p = m?.[1]?.trim();
      return p && p.length > 0 ? p : undefined;
    } catch {
      return undefined;
    }
  },
  dataDir: () => path.join(os.homedir(), '.dispatch'),
  logDir: () => path.join(os.homedir(), 'Library', 'Logs', 'dispatch'),
  resolveCommand: (name) => {
    try {
      return execFileSync('which', [name], { encoding: 'utf-8' }).trim() || null;
    } catch {
      return null;
    }
  },
  listProcessIds: () => {
    try {
      return execFileSync('ps', ['-eo', 'pid'], { encoding: 'utf-8' })
        .split('\n').map((l) => Number(l.trim())).filter(Number.isInteger);
    } catch {
      return [];
    }
  },
  claudeProjectDir: (workDir) =>
    path.join(os.homedir(), '.claude', 'projects', encodeClaudeProjectDir(workDir, 'darwin')),
  installBrowserShim: (opts) => installBrowserShim(opts),
  daemon: createDarwinDaemon(),
  flavor: 'macos',
  fileManagerName: 'Finder',
  // Argument array, never a shell string: a file named `$(rm -rf ~).png` is just a filename.
  // Absolute binary path, never a PATH lookup: the daemon runs under launchd, whose environment
  // is minimal and need not contain /usr/bin.
  revealInFileManager: (absPaths) =>
    new Promise((resolve, reject) =>
      execFile('/usr/bin/open', ['-R', ...absPaths], { timeout: 3000 }, (err) => (err ? reject(err) : resolve()))),
  isLocalClient: (c) => !c.proxied && isLoopbackAddress(c.remoteAddress) && isLoopbackHost(c.host),
  toolPlatformKey: () => (process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'),
  tailscaleStatus: () =>
    new Promise<TailscaleStatus>((resolve) => {
      execFile(TAILSCALE_BIN, ['status', '--json'], { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve({ ip: null, hostname: null, online: false });
        try {
          const status = JSON.parse(stdout);
          const self = status.Self || {};
          resolve({
            ip: (self.TailscaleIPs || [])[0] || null,
            hostname: self.HostName || null,
            online: self.Online || false,
          });
        } catch {
          resolve({ ip: null, hostname: null, online: false });
        }
      });
    }),
};
