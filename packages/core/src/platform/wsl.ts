import fs from 'fs';
import { linux } from './linux.js';
import type { Platform } from './types.js';

export interface WslDeps {
  execFile(cmd: string, args: string[]): Promise<{ stdout: string }>;
  readFileSync(p: string): string;
  env: NodeJS.ProcessEnv;
}

const defaultDeps: WslDeps = {
  execFile: async (cmd, args) => {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    return promisify(execFile)(cmd, args, { timeout: 5000 }) as Promise<{ stdout: string }>;
  },
  readFileSync: (p) => fs.readFileSync(p, 'utf-8'),
  env: process.env,
};

/** WSL_DISTRO_NAME is absent in some daemon contexts; /proc/version is authoritative. */
export function detectWsl(
  env: NodeJS.ProcessEnv = process.env,
  readProcVersion: () => string = () => fs.readFileSync('/proc/version', 'utf-8'),
): boolean {
  if (env.WSL_DISTRO_NAME) return true;
  try { return /microsoft/i.test(readProcVersion()); } catch { return false; }
}

export function createWslPlatform(deps: WslDeps = defaultDeps): Platform {
  void deps; // capability overrides land in Tasks 6, 10
  return { ...linux };
}

export const wsl: Platform = createWslPlatform();
