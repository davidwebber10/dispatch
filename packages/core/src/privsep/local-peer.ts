// packages/core/src/privsep/local-peer.ts
// Is the other end of a connection inside this box? (design section 6)
//
// With privilege separation the owner credential is accepted only from OUTSIDE the box: the router
// and the control plane. A process in the box reaches the daemon over loopback or over one of the
// box's own addresses, and both count as local. The answer comes from the socket's address, never
// from a header.
import os from 'node:os';

const strip = (a: string): string => {
  let s = a.trim().toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (s.startsWith('::ffff:') && s.includes('.')) s = s.slice(7);
  return s;
};

export function isLoopback(addr: string): boolean {
  const a = strip(addr);
  return a === '::1' || a === '0:0:0:0:0:0:0:1' || /^127\./.test(a);
}

let cache: { at: number; set: Set<string> } | null = null;

function ownAddresses(now: number, interfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>): Set<string> {
  if (cache && now - cache.at < 5_000) return cache.set;
  const set = new Set<string>();
  for (const list of Object.values(interfaces())) for (const i of list ?? []) set.add(strip(i.address));
  cache = { at: now, set };
  return set;
}

/**
 * True for a missing address (fail closed), a loopback address, or an address of one of this
 * machine's interfaces.
 */
export function isLocalPeer(
  remoteAddress: string | undefined | null,
  opts: { now?: number; interfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]> } = {},
): boolean {
  if (!remoteAddress) return true;
  if (isLoopback(remoteAddress)) return true;
  if (opts.interfaces) cache = null;
  return ownAddresses(opts.now ?? Date.now(), opts.interfaces ?? os.networkInterfaces).has(strip(remoteAddress));
}
