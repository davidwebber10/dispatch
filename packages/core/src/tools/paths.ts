import os from 'node:os';
import path from 'node:path';

export interface ToolPaths { dir: string; bin: string; cache: string; pkgs: string; installed: string; userManifest: string; }

export function toolPaths(base?: string): ToolPaths {
  const dir = base ?? path.join(os.homedir(), '.dispatch', 'tools');
  return {
    dir,
    bin: path.join(dir, 'bin'),
    cache: path.join(dir, 'cache'),
    pkgs: path.join(dir, 'pkgs'),
    installed: path.join(dir, 'installed.json'),
    userManifest: path.join(path.dirname(dir), 'tools.json'),
  };
}

export function hostPlatformKey(): string {
  return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
}
