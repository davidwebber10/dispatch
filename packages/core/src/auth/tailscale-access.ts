import { execFile } from 'node:child_process';

/**
 * Tailscale facts for the access gate (network exposure spec, 7.1 rule 3 and 7.2).
 *
 * "Owner's device" means: the peer address belongs to a live tailnet node that is owned by the
 * same Tailscale user as this machine, and is not a tagged node. Nodes shared in from another
 * tailnet have a different owner, so they do not count (decision NE-3, option A).
 */

export interface TsSelf { userId: number; login: string | null; names: string[]; ips: string[] }

export interface TailscaleAccess {
  self(): Promise<TsSelf | null>;
  isOwnerPeer(addr: string | undefined): Promise<boolean>;
}

export type TsExec = (bin: string, args: string[]) => Promise<string>;

const stripMapped = (a: string) => (a.startsWith('::ffff:') ? a.slice(7) : a);

/** 100.64.0.0/10 (carrier-grade NAT range Tailscale uses) or fd7a:115c:a1e0::/48. */
export function isTailscaleAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = stripMapped(addr).toLowerCase();
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(a);
  if (m) { const o = Number(m[1]); return o >= 64 && o <= 127; }
  return a.startsWith('fd7a:115c:a1e0:');
}

const MAC_APP_BIN = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
// `tailscale.exe` covers a WSL daemon whose Tailscale runs on the Windows host.
const BINS = ['tailscale', MAC_APP_BIN, 'tailscale.exe'];

const defaultExec: TsExec = (bin, args) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

const SELF_TTL_MS = 60_000;
const ALLOW_TTL_MS = 5 * 60_000;
const REFUSE_TTL_MS = 30_000;
const MAX_CACHE = 256;

export function createTailscaleAccess(opts: { exec?: TsExec; now?: () => number } = {}): TailscaleAccess {
  const exec = opts.exec ?? defaultExec;
  const now = opts.now ?? Date.now;
  let goodBin: string | null = null;

  async function run(args: string[]): Promise<string | null> {
    for (const bin of goodBin ? [goodBin] : BINS) {
      try { const out = await exec(bin, args); goodBin = bin; return out; } catch { /* try next */ }
    }
    return null;
  }

  let selfCache: { at: number; value: TsSelf | null } | null = null;
  let selfInflight: Promise<TsSelf | null> | null = null;
  function self(): Promise<TsSelf | null> {
    if (selfCache && now() - selfCache.at < SELF_TTL_MS) return Promise.resolve(selfCache.value);
    // Concurrent callers share one CLI run.
    return (selfInflight ??= loadSelf().finally(() => { selfInflight = null; }));
  }
  async function loadSelf(): Promise<TsSelf | null> {
    let value: TsSelf | null = null;
    const out = await run(['status', '--json']);
    if (out) {
      try {
        const s = JSON.parse(out)?.Self;
        if (s && typeof s.UserID === 'number') {
          const names: string[] = [];
          const dns = typeof s.DNSName === 'string' ? s.DNSName.replace(/\.$/, '').toLowerCase() : '';
          if (dns) { names.push(dns); names.push(dns.split('.')[0]); } // MagicDNS label, not the OS host name
          if (typeof s.HostName === 'string' && s.HostName) names.push(s.HostName.toLowerCase());
          const ips = Array.isArray(s.TailscaleIPs) ? s.TailscaleIPs.filter((i: unknown): i is string => typeof i === 'string') : [];
          const login = JSON.parse(out)?.User?.[String(s.UserID)]?.LoginName;
          value = { userId: s.UserID, login: typeof login === 'string' ? login.toLowerCase() : null, names: [...new Set(names)], ips };
        }
      } catch { /* leave null */ }
    }
    selfCache = { at: now(), value };
    return value;
  }

  const peerCache = new Map<string, { at: number; ok: boolean }>();
  const peerInflight = new Map<string, Promise<boolean>>();
  function isOwnerPeer(addr: string | undefined): Promise<boolean> {
    if (!addr || !isTailscaleAddress(addr)) return Promise.resolve(false);
    const key = stripMapped(addr);
    const hit = peerCache.get(key);
    if (hit && now() - hit.at < (hit.ok ? ALLOW_TTL_MS : REFUSE_TTL_MS)) return Promise.resolve(hit.ok);
    let p = peerInflight.get(key);
    if (!p) { p = lookupPeer(key).finally(() => peerInflight.delete(key)); peerInflight.set(key, p); }
    return p;
  }
  async function lookupPeer(key: string): Promise<boolean> {

    let ok = false;
    const me = await self();
    if (me) {
      const out = await run(['whois', '--json', key]);
      if (out) {
        try {
          const node = JSON.parse(out)?.Node;
          const tagged = Array.isArray(node?.Tags) && node.Tags.length > 0;
          ok = !!node && !tagged && node.User === me.userId;
        } catch { /* refuse */ }
      }
    }
    if (peerCache.size >= MAX_CACHE) peerCache.clear();
    peerCache.set(key, { at: now(), ok });
    return ok;
  }

  return { self, isOwnerPeer };
}
