import fs from 'node:fs';
import { keyKindOf } from './principals.js';

/**
 * The one credential resolver for the CLI, both MCP servers and the shim relay (spec 6.7),
 * plus the destination rule (spec 6.3): a key is sent only to the daemon's own URL.
 */
export type Credential =
  | { mode: 'owner'; header: string }
  | { mode: 'thread'; header: string }
  | { mode: 'none' }
  | { mode: 'refuse'; reason: string };

const NO_KEY = 'This thread has no Dispatch key';

function readKeyFile(file: string): string | null {
  try {
    const v = fs.readFileSync(file, 'utf8').split('\n')[0].trim();
    const kind = keyKindOf(v);
    return kind === 'thread' || kind === 'chat' ? v : null;
  } catch {
    return null;
  }
}

export function resolveCredential(opts: {
  env: NodeJS.ProcessEnv;
  purpose: 'cli' | 'mcp' | 'shim';
  readOwnerToken: () => string | null;
}): Credential {
  const { env, purpose } = opts;
  const owner = (): Credential => {
    const t = opts.readOwnerToken();
    return t ? { mode: 'owner', header: `Bearer ${t}` } : { mode: 'none' };
  };
  const auth = env.DISPATCH_AUTH;
  const kind = auth ? keyKindOf(auth) : null;
  if (auth && kind === 'shell') {
    if (purpose === 'shim') return { mode: 'thread', header: `Bearer ${auth}` };
    if (purpose === 'cli') return owner();
    return { mode: 'refuse', reason: 'A shell key cannot be used by an MCP server' };
  }
  if (auth && (kind === 'thread' || kind === 'chat')) return { mode: 'thread', header: `Bearer ${auth}` };
  if (env.DISPATCH_AUTH_FILE) {
    const k = readKeyFile(env.DISPATCH_AUTH_FILE);
    return k ? { mode: 'thread', header: `Bearer ${k}` } : { mode: 'refuse', reason: NO_KEY };
  }
  const marker = !!(env.DISPATCH_TERMINAL_ID || env.DISPATCH_TERMINAL);
  if (marker) {
    // Stage 1: the MCP and shim helpers send nothing and the daemon counts it. Never the owner token.
    return purpose === 'cli' ? { mode: 'refuse', reason: NO_KEY } : { mode: 'none' };
  }
  return purpose === 'cli' ? owner() : { mode: 'none' };
}

/** True only when DISPATCH_API is set and the URL is that origin and at or under its base path. */
export function keyAllowedFor(url: string, env: NodeJS.ProcessEnv): boolean {
  const api = env.DISPATCH_API;
  if (!api) return false;
  let a: URL;
  let u: URL;
  try {
    a = new URL(api);
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (a.origin !== u.origin) return false;
  const base = a.pathname.replace(/\/+$/, '');
  return u.pathname === base || u.pathname.startsWith(base + '/');
}
