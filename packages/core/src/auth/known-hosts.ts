import fs from 'node:fs';
import path from 'node:path';
import { hostnameOf } from '../files/reveal.js';

/** Lowercase host name from a Host header: no port, no brackets, no trailing dot. null if empty. */
export function normalizeHostHeader(host: string | undefined): string | null {
  if (!host) return null;
  const name = hostnameOf(host);
  if (!name) return null;
  return name.replace(/\.$/, '') || null;
}

/** localhost, any 127.x.y.z address, or ::1. Exact matches only: `localhost.evil.com` is not loopback. */
export function isLoopbackName(name: string | null): boolean {
  if (!name) return false;
  return name === 'localhost' || name === '::1' || /^127(\.\d{1,3}){3}$/.test(name);
}

/** Host and port of an Origin header value. null for `null`, junk and non-http(s) schemes. */
export function originHostPort(origin: string): { host: string; port: string } | null {
  let u: URL;
  try { u = new URL(origin); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = normalizeHostHeader(u.host);
  if (!host) return null;
  return { host, port: u.port || (u.protocol === 'https:' ? '443' : '80') };
}

export interface AccessConfig {
  allowedHosts(): string[];
  allowedOrigins(): string[];
  addHost(name: string): void;
  removeHost(name: string): void;
}

interface AccessFile { allowedHosts?: unknown; allowedOrigins?: unknown }

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * `<dataDir>/access.json`: the owner's list of extra host names (and origins) that count as
 * "this machine". Read by modification time, so `dispatch access allow-host` needs no restart.
 */
export function createAccessConfig(dataDir: string): AccessConfig {
  const file = path.join(dataDir, 'access.json');
  let cachedMtime = -1;
  let cached: AccessFile = {};

  const load = (): AccessFile => {
    let mtime: number;
    try { mtime = fs.statSync(file).mtimeMs; } catch { cachedMtime = -1; cached = {}; return cached; }
    if (mtime === cachedMtime) return cached;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      cached = parsed && typeof parsed === 'object' ? parsed : {};
    } catch { cached = {}; }
    cachedMtime = mtime;
    return cached;
  };

  const save = (hosts: string[]) => {
    const next = { ...load(), allowedHosts: hosts };
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    cachedMtime = -1;
  };

  return {
    allowedHosts: () => strings(load().allowedHosts).map((h) => normalizeHostHeader(h)).filter((h): h is string => !!h),
    allowedOrigins: () => strings(load().allowedOrigins),
    addHost(name) {
      const n = normalizeHostHeader(name);
      if (!n) throw new Error(`not a host name: ${name}`);
      const cur = this.allowedHosts();
      if (!cur.includes(n)) save([...cur, n]);
    },
    removeHost(name) {
      const n = normalizeHostHeader(name);
      save(this.allowedHosts().filter((h) => h !== n));
    },
  };
}
