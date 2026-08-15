import { execFile } from 'node:child_process';
import { AGENT_CLI, AGENT_TYPES, type AgentType } from '../providers/agent-types.js';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const exec = promisify(execFile);

/**
 * The agent CLIs Dispatch can drive, derived from the one harness list so a new provider
 * cannot be detected-but-not-spawnable (or the reverse).
 */
export type ProviderName = (typeof AGENT_CLI)[AgentType];
export const PROVIDER_NAMES: readonly ProviderName[] = AGENT_TYPES.map((t) => AGENT_CLI[t]);

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
  opencode: ['.opencode/bin/opencode', '.local/bin/opencode'],
};

/**
 * Where each CLI stores the credentials its interactive login writes.
 *
 * `definitive` says whether a missing credential file PROVES signed-out. It does for Grok:
 * the installer itself creates `~/.grok`, so the directory tells you nothing and only
 * `auth.json` does. For Claude and Codex the directory may exist for unrelated reasons and
 * the credential may live outside these files (a keychain, an env var), so a miss there is
 * honestly 'unknown' rather than false.
 */
const AUTH_FILES: Record<ProviderName, { dir: string; files: string[]; definitive: boolean }> = {
  claude: { dir: '.claude', files: ['.credentials.json', 'credentials.json'], definitive: false },
  codex: { dir: '.codex', files: ['auth.json'], definitive: false },
  grok: { dir: '.grok', files: ['auth.json'], definitive: true },
  // `opencode auth login` writes exactly this file. Not definitive: provider keys can also
  // arrive via env vars (e.g. OPENROUTER_API_KEY), which leave no file behind.
  opencode: { dir: '.local/share/opencode', files: ['auth.json'], definitive: false },
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

/**
 * Each CLI's own "am I signed in?" command, and how to read its answer.
 *
 * Asking the CLI beats looking for its credential file. The file only disappears on an
 * explicit logout — when a token merely EXPIRES it sits there unchanged, so a file check
 * reports "signed in" right up until the thread dead-ends on a login screen. These
 * commands reflect the token's real state.
 *
 * `read` returns 'unknown' when the output is not recognised, so an upgraded CLI that
 * changes its wording degrades to the file check rather than lying in either direction.
 */
const AUTH_PROBES: Record<ProviderName, { args: string[]; read(stdout: string): boolean | 'unknown' }> = {
  claude: {
    // `--json` is the documented default for this subcommand, but pass it explicitly so a
    // future change of default cannot silently turn this into prose parsing.
    args: ['auth', 'status', '--json'],
    read(stdout) {
      try {
        const parsed = JSON.parse(stdout) as { loggedIn?: unknown };
        return typeof parsed.loggedIn === 'boolean' ? parsed.loggedIn : 'unknown';
      } catch { return 'unknown'; }
    },
  },
  codex: {
    args: ['login', 'status'],
    read(stdout) {
      const t = stdout.toLowerCase();
      if (/\bnot logged in\b|\bnot authenticated\b|\bno credentials\b/.test(t)) return false;
      if (/\blogged in\b|\bauthenticated\b/.test(t)) return true;
      return 'unknown';
    },
  },
  grok: {
    // Grok has no status subcommand; `models` reports the account's reachable models and
    // says so plainly when there is no account.
    args: ['models'],
    read(stdout) {
      const t = stdout.toLowerCase();
      if (/not authenticated|not logged in|please (log|sign) in/.test(t)) return false;
      if (/model/.test(t)) return true;
      return 'unknown';
    },
  },
  opencode: {
    // `auth list` prints a credential count ("└  1 credentials"), verified on 1.18.18.
    // Zero credentials is honestly signed-out for our purposes: the free default model
    // works keyless, but the OpenRouter models Dispatch spawns do not.
    args: ['auth', 'list'],
    read(stdout) {
      const m = /(\d+)\s+credentials?/.exec(stdout);
      if (!m) return 'unknown';
      return Number(m[1]) > 0;
    },
  },
};

/** How long a signed-in answer is reused. Opening the New Thread modal must not spawn three
 *  processes every time, but a sign-in must show up promptly. */
const AUTH_CACHE_MS = 30_000;
const authCache = new Map<ProviderName, { at: number; value: boolean | 'unknown' }>();

/** Test seam: forget every cached answer. */
export function _resetAuthCache(): void {
  authCache.clear();
}

/** Ask the CLI directly. Returns null when the command could not be run at all. */
async function probeSignedIn(name: ProviderName, bin: string): Promise<boolean | 'unknown' | null> {
  const probe = AUTH_PROBES[name];
  try {
    const { stdout, stderr } = await exec(bin, probe.args, { timeout: 5000 });
    return probe.read(`${stdout}\n${stderr}`);
  } catch (err) {
    // A non-zero exit is how some CLIs say "not signed in", and its message is still on
    // stdout/stderr — read it before giving up.
    const out = err as { stdout?: string; stderr?: string };
    if (typeof out?.stdout === 'string' || typeof out?.stderr === 'string') {
      const verdict = probe.read(`${out.stdout ?? ''}\n${out.stderr ?? ''}`);
      if (verdict !== 'unknown') return verdict;
    }
    return null;
  }
}

function detectSignedInFromFile(name: ProviderName): boolean | 'unknown' {
  const home = os.homedir();
  try {
    const spec = AUTH_FILES[name];
    const dir = path.join(home, spec.dir);
    if (!existsSync(dir)) return false;
    if (spec.files.some((f) => existsSync(path.join(dir, f)))) return true;
    return spec.definitive ? false : 'unknown';
  } catch { return 'unknown'; }
}

export async function detectProvider(name: ProviderName, opts?: { fresh?: boolean }): Promise<ProviderStatus> {
  const bin = await resolveBin(name);
  if (!bin) {
    authCache.delete(name);
    return { name, installed: false, signedIn: false };
  }
  let version: string | undefined;
  // Invoke the resolved path, not the bare name — the bare name is not on the daemon's
  // PATH in exactly the fresh-install case FALLBACK_BINS exists for.
  try { const { stdout } = await exec(bin, ['--version'], { timeout: 4000 }); version = stdout.trim().split('\n')[0] || undefined; }
  catch { /* version is best-effort */ }

  const cached = authCache.get(name);
  if (!opts?.fresh && cached && Date.now() - cached.at < AUTH_CACHE_MS) {
    return { name, installed: true, version, signedIn: cached.value };
  }

  // Ask the CLI. Only a DEFINITIVE yes/no from it overrides the credential file: a probe
  // that could not run (null) or whose output we did not recognise ('unknown') means we
  // know nothing, and the file is better evidence than a shrug.
  const probed = await probeSignedIn(name, bin);
  const signedIn = probed === null || probed === 'unknown' ? detectSignedInFromFile(name) : probed;
  authCache.set(name, { at: Date.now(), value: signedIn });
  return { name, installed: true, version, signedIn };
}

export async function detectAllProviders(opts?: { fresh?: boolean }): Promise<ProviderStatus[]> {
  return Promise.all(PROVIDER_NAMES.map((n) => detectProvider(n, opts)));
}

/** Exposed for tests: how each CLI's status output is read. */
export const _AUTH_PROBES = AUTH_PROBES;

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
