import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import type { Platform } from './types.js';
import { encodeClaudeProjectDir } from './encode.js';
import { installBrowserShim } from '../auth/shim.js';

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
};
