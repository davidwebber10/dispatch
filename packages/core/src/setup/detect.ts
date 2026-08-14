import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const exec = promisify(execFile);

/** The agent CLIs Dispatch can drive. Keep in sync with PROVIDER_NAMES below. */
export type ProviderName = 'claude' | 'codex' | 'grok';
export const PROVIDER_NAMES: readonly ProviderName[] = ['claude', 'codex', 'grok'];

export interface ProviderStatus { name: ProviderName; installed: boolean; version?: string; signedIn: boolean | 'unknown'; }
export interface TailscaleStatus { installed: boolean; running: boolean; dnsName?: string; url?: string; }

/**
 * Where each CLI's installer puts its binary when it is NOT on the daemon's PATH.
 *
 * The daemon resolves the login shell's PATH once, at startup. A CLI installed *after*
 * that — which is exactly what the in-app Install button does — is therefore invisible to
 * `which` until the daemon restarts. Probing the installers' known locations lets a fresh
 * install light up immediately.
 */
const FALLBACK_BINS: Record<ProviderName, string[]> = {
  claude: ['.local/bin/claude', '.claude/local/claude'],
  codex: ['.local/bin/codex'],
  grok: ['.grok/bin/grok', '.local/bin/grok'],
};

/** Where each CLI stores the credentials its interactive login writes. */
const AUTH_FILES: Record<ProviderName, { dir: string; files: string[] }> = {
  claude: { dir: '.claude', files: ['.credentials.json', 'credentials.json'] },
  codex: { dir: '.codex', files: ['auth.json'] },
  grok: { dir: '.grok', files: ['auth.json'] },
};

async function which(bin: string): Promise<string | null> {
  try { const { stdout } = await exec('which', [bin]); return stdout.trim() || null; }
  catch { return null; }
}

/** `which`, then the installers' known paths — see FALLBACK_BINS. */
async function resolveBin(name: ProviderName): Promise<string | null> {
  const onPath = await which(name);
  if (onPath) return onPath;
  const home = os.homedir();
  for (const rel of FALLBACK_BINS[name]) {
    const abs = path.join(home, rel);
    if (existsSync(abs)) return abs;
  }
  return null;
}

function detectSignedIn(name: ProviderName): boolean | 'unknown' {
  const home = os.homedir();
  try {
    const spec = AUTH_FILES[name];
    const dir = path.join(home, spec.dir);
    if (!existsSync(dir)) return false;
    if (spec.files.some((f) => existsSync(path.join(dir, f)))) return true;
    return 'unknown';
  } catch { return 'unknown'; }
}

export async function detectProvider(name: ProviderName): Promise<ProviderStatus> {
  const bin = await resolveBin(name);
  if (!bin) return { name, installed: false, signedIn: false };
  let version: string | undefined;
  // Invoke the resolved path, not the bare name — the bare name is not on the daemon's
  // PATH in exactly the fresh-install case FALLBACK_BINS exists for.
  try { const { stdout } = await exec(bin, ['--version'], { timeout: 4000 }); version = stdout.trim().split('\n')[0] || undefined; }
  catch { /* version is best-effort */ }
  return { name, installed: true, version, signedIn: detectSignedIn(name) };
}

export async function detectAllProviders(): Promise<ProviderStatus[]> {
  return Promise.all(PROVIDER_NAMES.map(detectProvider));
}

const TS_APP_BIN = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

export async function detectTailscale(port: number): Promise<TailscaleStatus> {
  let bin = await which('tailscale');
  if (!bin && existsSync(TS_APP_BIN)) bin = TS_APP_BIN;
  if (!bin) return { installed: false, running: false };
  try {
    const { stdout } = await exec(bin, ['status', '--json'], { timeout: 2000 });
    const data = JSON.parse(stdout);
    const dnsName = data?.Self?.DNSName ? String(data.Self.DNSName).replace(/\.$/, '') : undefined;
    const running = data?.BackendState === 'Running';
    const url = running && dnsName ? `http://${dnsName}:${port}` : undefined;
    return { installed: true, running, dnsName, url };
  } catch { return { installed: true, running: false }; }
}
