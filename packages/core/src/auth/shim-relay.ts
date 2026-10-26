/**
 * The relay that the browser shims run instead of `curl` (spec 6.7). It posts one auth request to
 * the daemon: `node shim-relay.js URL SOURCE`. The URL to open is the first argument and the source
 * label is the second; nothing secret ever appears in argv. It reads DISPATCH_AUTH from its own
 * environment and sends it only to DISPATCH_API (the destination rule). It always exits 0: a
 * failed relay must never break the CLI that called the opener.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveCredential, keyAllowedFor } from './credential.js';

export interface RelayOptions {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  fetchImpl?: typeof fetch;
}

export async function runRelay(opts: RelayOptions): Promise<void> {
  const [url, source] = opts.argv;
  if (!url) return;
  const base = (opts.env.DISPATCH_API || opts.env.DISPATCH_SERVER_URL || '').replace(/\/+$/, '');
  if (!base) return;
  const target = `${base}/api/auth-requests`;
  const body: Record<string, string> = { url, source: source ?? 'browser-env', cwd: opts.cwd };
  const terminalId = opts.env.DISPATCH_TERMINAL_ID;
  if (terminalId) body.terminalId = terminalId;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const cred = resolveCredential({ env: opts.env, purpose: 'shim', readOwnerToken: () => null });
  if (cred.mode === 'thread' && keyAllowedFor(target, opts.env)) headers.Authorization = cred.header;
  try {
    await (opts.fetchImpl ?? fetch)(target, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  } catch { /* best effort */ }
}

// Run only as the entry point, not when imported by a test.
function isEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isEntryPoint()) {
  void runRelay({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() }).finally(() => process.exit(0));
}
