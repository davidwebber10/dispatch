import { darwin } from './darwin.js';
import { linux } from './linux.js';
import { detectWsl } from './wsl.js';
import { wsl } from './wsl.js';
import type { Platform } from './types.js';

export function selectPlatform(plat: NodeJS.Platform = process.platform): Platform {
  switch (plat) {
    case 'darwin': return darwin;
    case 'linux':  return detectWsl() ? wsl : linux;
    default:
      throw new Error(`Dispatch does not support platform "${plat}" (darwin/linux only; Windows runs Dispatch inside WSL2).`);
  }
}

export const platform: Platform = selectPlatform();
export type { Platform, ShellSpec, BrowserShimOptions, BrowserShimEnv } from './types.js';
export type { DaemonController, DaemonInstallOptions, DaemonStatus } from './daemon.js';
