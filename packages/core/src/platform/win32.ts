import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import type { Platform, ShellSpec, BrowserShimEnv } from './types.js';
import { encodeClaudeProjectDir } from './encode.js';
import { parseTasklistPids } from './win32-util.js';
import { createWin32Daemon } from './daemon-win32.js';

function whereExe(name: string): string | null {
  try {
    const out = execFileSync('where', [name], { encoding: 'utf-8' }).split(/\r?\n/)[0]?.trim();
    return out && out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

interface Win32Platform extends Platform {
  defaultShell(resolve?: (name: string) => string | null): ShellSpec;
}

export const win32: Win32Platform = {
  id: 'win32',
  defaultShell: (resolve = whereExe) => {
    const pwsh = resolve('pwsh');
    return { command: pwsh ?? 'powershell.exe', args: ['-NoLogo'] };
  },
  resolveLoginPath: () => undefined,
  dataDir: () => path.join(os.homedir(), '.dispatch'),
  logDir: () =>
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'dispatch', 'logs'),
  resolveCommand: (name) => whereExe(name),
  listProcessIds: () => {
    try {
      return parseTasklistPids(execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf-8' }));
    } catch {
      return [];
    }
  },
  claudeProjectDir: (workDir) =>
    path.join(os.homedir(), '.claude', 'projects', encodeClaudeProjectDir(workDir, 'win32')),
  installBrowserShim: (): BrowserShimEnv => ({}),
  daemon: createWin32Daemon(),
};
