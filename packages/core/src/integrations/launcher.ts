/**
 * Integration launcher — the MCP server command for an integration whose header or env
 * values reference `${NAME}` secrets (see secret-refs.ts). Every harness (Claude Code,
 * Codex, Grok, OpenCode) runs it as the server:
 *
 *   node dist/integrations/launcher.js --secrets-dir <dir> --spec <base64url JSON>
 *
 * The spec carries the integration's templates only, never a value — and only the env
 * entries that hold a ref; literal env entries reach the launcher through the harness's
 * usual spec `env` and pass to the child by inheritance. At start-up the launcher resolves
 * each ref — Doppler first (when connected and enabled), then its own env — and spawns the
 * real server with the values in THAT child's env and nowhere else: not argv (an EDR agent
 * logs every process's argv), not a config file, not dispatch.db, not the agent's own shell
 * env. Base64 also stops Claude Code from expanding `${...}` in --mcp-config args on its own.
 *
 *   stdio   command + args; env = inherited + the spec's env entries with refs substituted
 *   remote  npx -y mcp-remote <url> --header K:<template>, the template LITERAL in argv.
 *           mcp-remote substitutes `${NAME}` in header values from its own env (verified in
 *           0.14.3: substituteEnvVars, applied to every --header), so each resolved
 *           NAME=value goes into its env instead.
 *
 * Imports stay light (no server, no db): this starts once per server per thread.
 */
import { spawn as nodeSpawn } from 'child_process';
import { SecretsService, type DopplerStatus } from '../secrets/service.js';
import { findSecretRefs, refsIn, substituteSecretRefs } from './secret-refs.js';

/** The integration's templates — `${NAME}` refs unresolved. */
export interface LaunchSpec {
  /** For the error line only. */
  name?: string;
  type: 'stdio' | 'remote';
  command?: string | null;
  args?: string[];
  url?: string | null;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

/** The child to spawn. `env` is added to the launcher's own env and is the only place a value goes. */
export interface LaunchPlan { command: string; args: string[]; env: Record<string, string> }

export type SecretSource = Pick<SecretsService, 'status' | 'getSecret'>;

export interface LauncherDeps {
  /** Opens the Doppler connection the daemon saved in --secrets-dir. */
  secrets?: (secretsDir: string) => SecretSource;
  env?: NodeJS.ProcessEnv;
  stderr?: (line: string) => void;
  spawn?: typeof nodeSpawn;
}

export interface LauncherExit { code: number | null; signal: NodeJS.Signals | null }

export function encodeLaunchSpec(spec: LaunchSpec): string {
  return Buffer.from(JSON.stringify(spec), 'utf8').toString('base64url');
}

export function decodeLaunchSpec(encoded: string): LaunchSpec {
  let spec: any;
  try { spec = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { spec = null; }
  if (spec?.type === 'stdio' && typeof spec.command === 'string' && spec.command) return spec;
  if (spec?.type === 'remote' && typeof spec.url === 'string' && spec.url) return spec;
  throw new Error('invalid --spec');
}

/** The server's args after `node`. */
export function launcherArgs(launcherPath: string, secretsDir: string, spec: LaunchSpec): string[] {
  return [launcherPath, '--secrets-dir', secretsDir, '--spec', encodeLaunchSpec(spec)];
}

function parseArgv(argv: string[]): { secretsDir: string; spec: LaunchSpec } {
  const valueOf = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] ?? '' : ''; };
  const secretsDir = valueOf('--secrets-dir');
  const encoded = valueOf('--spec');
  if (!secretsDir || !encoded) throw new Error('usage: launcher --secrets-dir <dir> --spec <base64url JSON>');
  return { secretsDir, spec: decodeLaunchSpec(encoded) };
}

/** Templates + resolved values → the child. Pure; no value is ever placed in `args`. */
export function buildLaunch(spec: LaunchSpec, values: Record<string, string>): LaunchPlan {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.env ?? {})) env[k] = substituteSecretRefs(String(v), values);
  if (spec.type === 'stdio') return { command: spec.command ?? '', args: spec.args ?? [], env };
  const headers = Object.entries(spec.headers ?? {});
  for (const [, v] of headers) for (const name of refsIn(String(v))) if (Object.hasOwn(values, name)) env[name] = values[name];
  return {
    command: 'npx',
    args: ['-y', 'mcp-remote', spec.url ?? '', ...headers.flatMap(([k, v]) => ['--header', `${k}:${v}`])],
    env,
  };
}

/** One line naming the missing refs and the Doppler project/config. Never a value. */
function missingLine(spec: LaunchSpec, missing: string[], st: DopplerStatus | null): string {
  const refs = missing.map((n) => '${' + n + '}').join(', ');
  const where = st?.project && st?.config ? ` (${st.project}/${st.config})` : '';
  const why = !st?.connected ? `not set in the environment, and Doppler${where} is not connected`
    : !st.enabled ? `not set in the environment, and Doppler${where} is turned off`
    : `not set in Doppler${where} or the environment`;
  return `dispatch integration "${String(spec.name ?? '').replace(/[\r\n]/g, ' ')}": cannot resolve ${refs}: ${why}`;
}

const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

function runChild(plan: LaunchPlan, spec: LaunchSpec, baseEnv: NodeJS.ProcessEnv, spawn: typeof nodeSpawn, stderr: (line: string) => void): Promise<LauncherExit> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = spawn(plan.command, plan.args, { stdio: 'inherit', env: { ...baseEnv, ...plan.env } });
    } catch (e) {
      stderr(`dispatch integration "${spec.name ?? ''}": could not start ${plan.command}: ${(e as Error).message}`);
      resolve({ code: 1, signal: null });
      return;
    }
    const forward = (signal: NodeJS.Signals) => { try { child.kill(signal); } catch { /* already gone */ } };
    for (const s of FORWARDED) process.on(s, forward);
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      for (const s of FORWARDED) process.off(s, forward);
      resolve({ code, signal });
    };
    child.on('exit', finish);
    child.on('error', (e) => {
      stderr(`dispatch integration "${spec.name ?? ''}": could not start ${plan.command}: ${e.message}`);
      finish(127, null);
    });
  });
}

/** Resolve the spec's refs, then run the server until it exits. Exit 1 (nothing spawned) when a ref can't be resolved. */
export async function runLauncher(argv: string[], deps: LauncherDeps = {}): Promise<LauncherExit> {
  const env = deps.env ?? process.env;
  const stderr = deps.stderr ?? ((line: string) => { process.stderr.write(line + '\n'); });
  let parsed: { secretsDir: string; spec: LaunchSpec };
  try { parsed = parseArgv(argv); } catch (e) {
    stderr(`dispatch integration launcher: ${(e as Error).message}`);
    return { code: 1, signal: null };
  }
  const { secretsDir, spec } = parsed;

  const names = findSecretRefs(spec);
  let source: SecretSource | null = null;
  let status: DopplerStatus | null = null;
  if (names.length) {
    try {
      source = (deps.secrets ?? ((dir: string) => new SecretsService(dir)))(secretsDir);
      status = source.status();
    } catch { /* unreadable connection — own env only */ }
  }
  const useDoppler = !!source && !!status?.connected && !!status.enabled;

  const values: Record<string, string> = {};
  await Promise.all(names.map(async (name) => {
    let v: string | null = null;
    // A lookup failure (network, 404) is a miss, not a crash: the env fallback still applies.
    if (useDoppler) { try { v = await source!.getSecret(name); } catch { v = null; } }
    if (typeof v !== 'string') v = env[name] ?? null;
    if (typeof v === 'string') values[name] = v;
  }));
  const missing = names.filter((n) => !Object.hasOwn(values, n));
  if (missing.length) {
    stderr(missingLine(spec, missing, status));
    return { code: 1, signal: null };
  }

  return runChild(buildLaunch(spec, values), spec, env, deps.spawn ?? nodeSpawn, stderr);
}

// Run only as the entry point (`node dist/integrations/launcher.js`), not when imported.
if (process.argv[1] && /integrations[\\/]launcher\.(js|mjs|ts)$/.test(process.argv[1])) {
  void runLauncher(process.argv.slice(2)).then(({ code, signal }) => {
    if (signal) {
      // Our forwarding handlers are gone, so this ends us the same way the child ended.
      process.exitCode = 1;
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}
