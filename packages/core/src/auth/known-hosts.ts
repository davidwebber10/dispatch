import fs from 'node:fs';
import path from 'node:path';
import { hostnameOf } from '../files/reveal.js';
import { parseCloudflareAccess, type CloudflareAccessConfig } from './cf-access.js';

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
  /**
   * The Cloudflare Access check (`dispatch access cloudflare`). null: no check, and an allow-listed
   * host is trusted by its name alone, as in every version before the check existed. Set: an
   * allow-listed host needs a valid `Cf-Access-Jwt-Assertion`. A saved value that is not valid
   * reads as `{ teamDomain: '', aud: '' }`: the check is on and nothing can pass it.
   */
  cloudflareAccess(): CloudflareAccessConfig | null;
  /** Save the check, or remove it with null. Throws on a value that is not a team domain and an aud tag. */
  setCloudflareAccess(value: { teamDomain: string; aud: string } | null): void;
}

interface AccessFile { allowedHosts?: unknown; allowedOrigins?: unknown; cloudflareAccess?: unknown }

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

  const save = (change: (cur: AccessFile) => AccessFile) => {
    const next = change({ ...load() });
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    cachedMtime = -1;
  };

  return {
    allowedHosts: () => strings(load().allowedHosts).map((h) => normalizeHostHeader(h)).filter((h): h is string => !!h),
    allowedOrigins: () => strings(load().allowedOrigins).map((o) => o.trim().toLowerCase().replace(/\/+$/, '')),
    addHost(name) {
      const n = normalizeHostHeader(name);
      if (!n) throw new Error(`not a host name: ${name}`);
      const cur = this.allowedHosts();
      if (!cur.includes(n)) save((f) => ({ ...f, allowedHosts: [...cur, n] }));
    },
    removeHost(name) {
      const n = normalizeHostHeader(name);
      const hosts = this.allowedHosts().filter((h) => h !== n);
      save((f) => ({ ...f, allowedHosts: hosts }));
    },
    cloudflareAccess() {
      const raw = load().cloudflareAccess;
      if (raw === undefined || raw === null) return null;
      return parseCloudflareAccess(raw) ?? { teamDomain: '', aud: '' };
    },
    setCloudflareAccess(value) {
      if (value === null) {
        save((f) => { const { cloudflareAccess: _gone, ...rest } = f; void _gone; return rest; });
        return;
      }
      const parsed = parseCloudflareAccess(value);
      if (!parsed) {
        const domainOk = parseCloudflareAccess({ teamDomain: value.teamDomain, aud: 'x'.repeat(32) }) !== null;
        throw new Error(domainOk
          ? 'not an aud tag: copy the Application Audience (AUD) Tag from the Access application'
          : 'not a team domain: it has the form <name>.cloudflareaccess.com');
      }
      save((f) => ({ ...f, cloudflareAccess: parsed }));
    },
  };
}
