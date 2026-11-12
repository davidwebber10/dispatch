import { darwin } from './darwin.js';
import { linux } from './linux.js';
import { detectWsl } from './wsl.js';
import { wsl } from './wsl.js';
import type { Platform } from './types.js';
import path from 'node:path';
import { privsep } from '../privsep/config.js';

export function selectPlatform(plat: NodeJS.Platform = process.platform): Platform {
  switch (plat) {
    case 'darwin': return darwin;
    case 'linux':  return detectWsl() ? wsl : linux;
    default:
      throw new Error(`Dispatch does not support platform "${plat}" (darwin/linux only; Windows runs Dispatch inside WSL2).`);
  }
}

const base: Platform = selectPlatform();

/**
 * On a box with privilege separation (privsep/config.ts) the data and log directories are the
 * daemon's private state root, outside the person's home. Everywhere else: the platform's own.
 */
export const platform: Platform = {
  ...base,
  dataDir: () => privsep()?.stateDir ?? base.dataDir(),
  logDir: () => { const p = privsep(); return p ? path.join(p.stateDir, 'logs') : base.logDir(); },
};
export type { Platform, ShellSpec, BrowserShimOptions, BrowserShimEnv } from './types.js';
export type { DaemonController, DaemonInstallOptions, DaemonStatus } from './daemon.js';
