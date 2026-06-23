import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const exec = promisify(execFile);

export interface ProviderStatus { name: 'claude' | 'codex'; installed: boolean; version?: string; signedIn: boolean | 'unknown'; }
export interface TailscaleStatus { installed: boolean; running: boolean; dnsName?: string; url?: string; }

async function which(bin: string): Promise<string | null> {
  try { const { stdout } = await exec('which', [bin]); return stdout.trim() || null; }
  catch { return null; }
}

function detectSignedIn(name: 'claude' | 'codex'): boolean | 'unknown' {
  const home = os.homedir();
  try {
    if (name === 'claude') {
      const dir = path.join(home, '.claude');
      if (!existsSync(dir)) return false;
      if (['.credentials.json', 'credentials.json'].some((f) => existsSync(path.join(dir, f)))) return true;
      return 'unknown';
    }
    const dir = path.join(home, '.codex');
    if (!existsSync(dir)) return false;
    if (existsSync(path.join(dir, 'auth.json'))) return true;
    return 'unknown';
  } catch { return 'unknown'; }
}

export async function detectProvider(name: 'claude' | 'codex'): Promise<ProviderStatus> {
  const bin = await which(name);
  if (!bin) return { name, installed: false, signedIn: false };
  let version: string | undefined;
  try { const { stdout } = await exec(name, ['--version'], { timeout: 4000 }); version = stdout.trim().split('\n')[0] || undefined; }
  catch { /* version is best-effort */ }
  return { name, installed: true, version, signedIn: detectSignedIn(name) };
}

export async function detectAllProviders(): Promise<ProviderStatus[]> {
  return Promise.all([detectProvider('claude'), detectProvider('codex')]);
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
