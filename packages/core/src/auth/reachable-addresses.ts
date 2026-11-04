import os from 'node:os';
import { isTailscaleAddress } from './tailscale-access.js';

/**
 * Addresses another device (a phone) could use to reach this computer, for Settings > Access.
 * A browser on this computer cannot learn them: it only knows `localhost`. Owner only.
 */
export interface Reachable { tailscale: string[]; lan: string[] }

type Ifaces = ReturnType<typeof os.networkInterfaces>;

const isV4 = (family: string | number) => family === 'IPv4' || family === 4;
const isLinkLocal = (a: string) => a.startsWith('169.254.');

/** Lower is better: home and office Wi-Fi first, Docker's 172.16/12 bridges last. */
function lanRank(a: string): number {
  if (a.startsWith('192.168.')) return 0;
  if (a.startsWith('10.')) return 1;
  const m = /^172\.(\d+)\./.exec(a);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return 3;
  return 2;
}

/**
 * Pure choice step. `tsIps` are this machine's Tailscale addresses from `tailscale status`. They are
 * offered only when an interface here holds one (Tailscale is up). On WSL the Tailscale client runs on
 * the Windows host, so there is no local interface to check, and the VM's own address is no use to a
 * phone, so none is offered.
 */
export function pickReachable(opts: { tsIps: string[]; ifaces: Ifaces; wsl: boolean }): Reachable {
  const all: { name: string; address: string }[] = [];
  for (const [name, list] of Object.entries(opts.ifaces)) {
    for (const i of list ?? []) {
      if (isV4(i.family) && !i.internal && !isLinkLocal(i.address)) all.push({ name, address: i.address });
    }
  }
  const local = new Set(all.map((x) => x.address));
  const tailscale = opts.tsIps.filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip) && isTailscaleAddress(ip) && (opts.wsl || local.has(ip)));
  const lan = opts.wsl ? [] : all.map((x) => x.address).filter((a) => !isTailscaleAddress(a))
    .sort((a, b) => lanRank(a) - lanRank(b));
  return { tailscale, lan: [...new Set(lan)] };
}

export function reachableAddresses(tsIps: string[], wsl: boolean): Reachable {
  return pickReachable({ tsIps, ifaces: os.networkInterfaces(), wsl });
}
