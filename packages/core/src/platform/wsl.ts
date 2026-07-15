import fs from 'fs';
import { linux } from './linux.js';
import type { Platform } from './types.js';
import { isLoopbackAddress, isLoopbackHost } from '../files/reveal.js';

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

/** /proc/net/route stores IPv4 as little-endian hex: 0120A8C0 → C0.A8.20.01 → 192.168.32.1. */
export function parseDefaultGateway(routeText: string): string | null {
  for (const line of routeText.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 3 && cols[1] === '00000000' && cols[2] !== '00000000') {
      const hex = cols[2];
      const octets = [hex.slice(6, 8), hex.slice(4, 6), hex.slice(2, 4), hex.slice(0, 2)]
        .map((h) => parseInt(h, 16));
      if (octets.every((o) => Number.isInteger(o))) return octets.join('.');
    }
  }
  return null;
}

export function createWslPlatform(deps: WslDeps = defaultDeps): Platform {
  let gateway: string | null | undefined; // cached; undefined = unread
  const readGateway = () => {
    if (gateway === undefined) {
      try { gateway = parseDefaultGateway(deps.readFileSync('/proc/net/route')); } catch { gateway = null; }
    }
    return gateway;
  };
  return {
    ...linux,
    flavor: 'wsl',
    fileManagerName: 'File Explorer',
    // explorer.exe /select, accepts ONE path (unlike `open -R`); reveal the first.
    // The macOS multi-select rationale (Finder Cmd-C into upload fields) has a native
    // Windows equivalent: dragging from Explorer into the browser works directly.
    revealInFileManager: async (absPaths) => {
      if (!absPaths.length) return;
      const { stdout } = await deps.execFile('wslpath', ['-w', absPaths[0]]);
      try {
        await deps.execFile('explorer.exe', ['/select,' + stdout.trim()]);
      } catch (err) {
        // explorer.exe exits 1 even on success; only surface spawn failures (ENOENT = no interop).
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err;
      }
    },
    // Windows-host browser over WSL NAT arrives from the gateway IP, not loopback.
    // Host-header + proxy-header discipline still refuses portproxy'd LAN and tunnels.
    isLocalClient: (c) =>
      !c.proxied && isLoopbackHost(c.host) &&
      (isLoopbackAddress(c.remoteAddress) || (!!readGateway() && c.remoteAddress?.replace(/^::ffff:/, '') === readGateway())),
    tailscaleStatus: async () => {
      for (const bin of ['tailscale', 'tailscale.exe']) {
        try {
          const { stdout } = await deps.execFile(bin, ['status', '--json']);
          const s = JSON.parse(stdout);
          const self = s.Self ?? {};
          return { ip: self.TailscaleIPs?.[0] ?? null, hostname: self.HostName ?? null, online: !!self.Online };
        } catch { /* try next */ }
      }
      return { ip: null, hostname: null, online: false };
    },
  };
}

export const wsl: Platform = createWslPlatform();
