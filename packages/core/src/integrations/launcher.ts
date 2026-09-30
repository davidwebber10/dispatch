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
 * Nothing the launcher writes can carry a value: a value with a NUL (or CR/LF, for a header)
 * is refused before the spawn, a spawn error prints only its code, and the server's stderr —
 * which the harness keeps in its logs — is piped through with every value [redacted].
 *
 * Imports stay light (no server, no db): this starts once per server per thread.
 */
import { spawn as nodeSpawn } from 'child_process';
import type { Readable } from 'stream';
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

/** The parsed argv, or a fixed problem string (never exception text) for the stderr line. */
function parseArgv(argv: string[]): { secretsDir: string; spec: LaunchSpec } | string {
  const valueOf = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] ?? '' : ''; };
  const secretsDir = valueOf('--secrets-dir');
  const encoded = valueOf('--spec');
  if (!secretsDir || !encoded) return 'usage: launcher --secrets-dir <dir> --spec <base64url JSON>';
  try { return { secretsDir, spec: decodeLaunchSpec(encoded) }; } catch { return 'invalid --spec'; }
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

/** The start of every stderr line about one integration, kept to one line. */
function label(spec: LaunchSpec): string {
  return `dispatch integration "${String(spec.name ?? '').replace(/[\r\n\0]/g, ' ')}"`;
}

/** One line naming the missing refs and the Doppler project/config. Never a value. */
function missingLine(spec: LaunchSpec, missing: string[], st: DopplerStatus | null): string {
  const refs = missing.map((n) => '${' + n + '}').join(', ');
  const where = st?.project && st?.config ? ` (${st.project}/${st.config})` : '';
  const why = !st?.connected ? `not set in the environment, and Doppler${where} is not connected`
    : !st.enabled ? `not set in the environment, and Doppler${where} is turned off`
    : `not set in Doppler${where} or the environment`;
  return `${label(spec)}: cannot resolve ${refs}: ${why}`;
}

/**
 * Values that would break the spawn or a header, named by ref or env key, never quoted.
 * Checked BEFORE spawning: Node's own error for a NUL in env (ERR_INVALID_ARG_VALUE) quotes
 * the value. A header value also cannot hold CR or LF.
 */
function unsafeValues(spec: LaunchSpec, values: Record<string, string>): string[] {
  const problems: string[] = [];
  const headerRefs = new Set(spec.type === 'remote' ? Object.values(spec.headers ?? {}).flatMap((v) => refsIn(String(v))) : []);
  for (const [name, v] of Object.entries(values)) {
    if (headerRefs.has(name) && /[\r\n\0]/.test(v)) problems.push('${' + name + '} has a CR, LF or NUL, which a header value cannot hold');
    else if (v.includes('\0')) problems.push('${' + name + '} has a NUL byte');
  }
  // A NUL typed into the template itself isn't secret, but spawn's error would quote the whole substituted value.
  for (const [k, v] of Object.entries(spec.env ?? {})) if (String(v).includes('\0')) problems.push(`env ${k} has a NUL byte`);
  return problems;
}

/**
 * Values shorter than this are not redacted: a 1–3 character value ("1", "dev") would mangle
 * unrelated output while hiding almost nothing.
 */
const MIN_REDACT = 4;

/** Replaces every resolved value in one line of the server's stderr with [redacted]. */
function redactor(values: string[]): (line: string) => string {
  const targets = new Set<string>();
  for (const v of values) {
    targets.add(v);
    // Redaction runs line by line, so a multi-line value (a PEM key) is also matched one line at a time.
    for (const part of v.split(/\r?\n/)) targets.add(part);
  }
  const list = [...targets].filter((t) => t.length >= MIN_REDACT).sort((a, b) => b.length - a.length);
  return (line) => list.reduce((out, t) => out.split(t).join('[redacted]'), line);
}

/** Line-buffer a stream through `redact` into `write`; returns a flush for a partial last line. */
function pipeRedacted(stream: Readable, redact: (line: string) => string, write: (line: string) => void): () => void {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    pending += chunk;
    for (let nl = pending.indexOf('\n'); nl >= 0; nl = pending.indexOf('\n')) {
      write(redact(pending.slice(0, nl)));
      pending = pending.slice(nl + 1);
    }
  });
  return () => { if (pending) write(redact(pending)); pending = ''; };
}

/** A spawn error's message can quote env values; only its code (ENOENT, EACCES, …) and the command template are safe. */
function startFailure(spec: LaunchSpec, command: string, e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return `${label(spec)}: could not start ${command}: ${typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'spawn failed'}`;
}

const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

function runChild(plan: LaunchPlan, spec: LaunchSpec, baseEnv: NodeJS.ProcessEnv, spawn: typeof nodeSpawn, stderr: (line: string) => void, redact: (line: string) => string): Promise<LauncherExit> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof nodeSpawn>;
    try {
      // stdin and stdout are the MCP channel and pass through untouched. stderr is piped only
      // to redact it: mcp-remote logs fatal errors (a header error can quote the header), and
      // the harness keeps MCP stderr in its logs.
      child = spawn(plan.command, plan.args, { stdio: ['inherit', 'inherit', 'pipe'], env: { ...baseEnv, ...plan.env } });
    } catch (e) {
      stderr(startFailure(spec, plan.command, e));
      resolve({ code: 1, signal: null });
      return;
    }
    const forward = (signal: NodeJS.Signals) => { try { child.kill(signal); } catch { /* already gone */ } };
    for (const s of FORWARDED) process.on(s, forward);
    let exited: LauncherExit | null = null;
    let drained = !child.stderr;
    let settled = false;
    const settle = () => {
      if (settled || !exited || !drained) return;
      settled = true;
      for (const s of FORWARDED) process.off(s, forward);
      resolve(exited);
    };
    let flush = () => {};
    const drain = () => { if (drained) return; flush(); drained = true; settle(); };
    if (child.stderr) {
      flush = pipeRedacted(child.stderr, redact, stderr);
      child.stderr.on('end', drain);
      child.stderr.on('error', drain);
    }
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      // A grandchild that outlives the server can hold stderr open; don't wait on it forever.
      if (!drained) setTimeout(drain, 1000).unref();
      settle();
    });
    child.on('error', (e) => {
      stderr(startFailure(spec, plan.command, e));
      exited ??= { code: 127, signal: null };
      drain();
      settle();
    });
  });
}

/** Resolve the spec's refs, then run the server until it exits. Exit 1 (nothing spawned) when a ref can't be resolved or is unsafe. */
export async function runLauncher(argv: string[], deps: LauncherDeps = {}): Promise<LauncherExit> {
  const env = deps.env ?? process.env;
  const stderr = deps.stderr ?? ((line: string) => { process.stderr.write(line + '\n'); });
  const parsed = parseArgv(argv);
  if (typeof parsed === 'string') {
    stderr(`dispatch integration launcher: ${parsed}`);
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
  const unsafe = unsafeValues(spec, values);
  if (unsafe.length) {
    stderr(`${label(spec)}: refusing to start: ${unsafe.join('; ')}`);
    return { code: 1, signal: null };
  }

  return runChild(buildLaunch(spec, values), spec, env, deps.spawn ?? nodeSpawn, stderr, redactor(Object.values(values)));
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
