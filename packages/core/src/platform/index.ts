import { darwin } from './darwin.js';
import { win32 } from './win32.js';
import type { Platform } from './types.js';

function select(): Platform {
  switch (process.platform) {
    case 'darwin': return darwin;
    case 'win32': return win32;
    default:
      throw new Error(`Dispatch does not support platform "${process.platform}" yet (darwin/win32 only).`);
  }
}

export const platform: Platform = select();
export type { Platform, ShellSpec, BrowserShimOptions, BrowserShimEnv } from './types.js';
export type { DaemonController, DaemonInstallOptions, DaemonStatus } from './daemon.js';
