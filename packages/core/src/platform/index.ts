import { darwin } from './darwin.js';
import { linux } from './linux.js';
import { win32 } from './win32.js';
import type { Platform } from './types.js';

export function selectPlatform(plat: NodeJS.Platform = process.platform): Platform {
  switch (plat) {
    case 'darwin': return darwin;
    case 'linux':  return linux;
    case 'win32':  return win32;
    default:
      throw new Error(`Dispatch does not support platform "${plat}" yet (darwin/linux/win32 only).`);
  }
}

export const platform: Platform = selectPlatform();
export type { Platform, ShellSpec, BrowserShimOptions, BrowserShimEnv } from './types.js';
export type { DaemonController, DaemonInstallOptions, DaemonStatus } from './daemon.js';
