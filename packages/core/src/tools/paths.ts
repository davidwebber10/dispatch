import os from 'node:os';
import path from 'node:path';
import { platform } from '../platform/index.js';

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
  return platform.toolPlatformKey();
}

/** OS family portion of hostPlatformKey(), e.g. 'darwin' from 'darwin-arm64'. Used to gate
 *  ToolEntry.platforms, which is coarser (OS-only) than the arch-specific binary asset keys. */
export function hostOsFamily(): string {
  return hostPlatformKey().split('-')[0];
}
