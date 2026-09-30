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
 * Nothing the launcher writes to its own stderr (which the harness keeps in its logs) can
 * carry a value: only fixed lines — nothing on a clean run; a missing ref, an unsafe value (a
 * NUL, or CR/LF in a header, refused before the spawn), a spawn error's code, or "exited with
 * code N; its stderr is in <path>". The server's stderr never reaches the harness: a server
 * can print a value in forms no filter can enumerate (util.inspect escapes, a 1–3 character
 * value). It goes to this launcher's own file, <secretsDir>/logs/integrations/<name>.<pid>.log
 * (dir 0700, file 0600, rotated once at ~1 MiB; no file is shared between launchers), redacted
 * there too as defense in depth; the file can still hold other encodings of a value, which is
 * why it is 0600. At start the launcher prunes dead launchers' logs of the same integration
 * (keeps the 5 newest runs, none older than 7 days). A detached grandchild that outlives the
 * server can get EPIPE on stderr after the 1 s drain.
 *
 * Imports stay light (no server, no db): this starts once per server per thread.
 */
import { spawn as nodeSpawn } from 'child_process';
import fs from 'fs';
import path from 'path';
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
  /** The launcher's own stderr, which the harness logs: fixed lines only. */
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

/**
 * Replaces every resolved value in one line of the server's stderr with [redacted]: its
 * verbatim form and its JSON-escaped form (a server that logs JSON). Not other transformations.
 */
export function redactor(values: string[]): (line: string) => string {
  const raw = new Set<string>();
  for (const v of values) {
    raw.add(v);
    // Redaction runs line by line, so a multi-line value (a PEM key) is also matched one line at a time.
    for (const part of v.split(/\r\n|\r|\n/)) raw.add(part);
  }
  const targets = new Set<string>();
  for (const t of raw) { targets.add(t); targets.add(JSON.stringify(t).slice(1, -1)); }
  const list = [...targets].filter((t) => t.length >= MIN_REDACT).sort((a, b) => b.length - a.length);
  return (line) => list.reduce((out, t) => out.split(t).join('[redacted]'), line);
}

/** The most of an unterminated line held between chunks (characters); the rest is written through. */
const MAX_PENDING = 64 * 1024;

/**
 * Line-buffer a stream through `redact` into `write` (one batch of text, lines ending in \n, per
 * chunk); returns a flush for a partial last line. A line ends at \n, \r\n, or a lone \r
 * (progress output, which would otherwise never flush). A \r that ends a chunk waits for the
 * next one, which may bring its \n. An unterminated line past MAX_PENDING is written through in
 * pieces, so memory stays bounded; a value split across two pieces is not redacted, which the
 * 0600 log file accepts.
 */
export function pipeRedacted(stream: Readable, redact: (line: string) => string, write: (text: string) => void): () => void {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    pending += chunk;
    let out = '';
    const eol = /\r\n|\n|\r(?!$)/g;
    let start = 0;
    for (let m = eol.exec(pending); m; m = eol.exec(pending)) {
      out += redact(pending.slice(start, m.index)) + '\n';
      start = m.index + m[0].length;
    }
    pending = pending.slice(start);
    while (pending.length > MAX_PENDING) {
      out += redact(pending.slice(0, MAX_PENDING));
      pending = pending.slice(MAX_PENDING);
    }
    if (out) write(out);
  });
  return () => { if (pending) write(redact(pending.replace(/\r$/, '')) + '\n'); pending = ''; };
}

/** About where a launcher's log rotates, once, to `<name>.<pid>.log.1`. */
const LOG_CAP = 1024 * 1024;
/** Retention per integration: dead launchers' runs kept, and the age past which a dead run goes regardless. */
const KEEP_DEAD_RUNS = 5;
const MAX_DEAD_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function safeLogName(name: string | undefined): string {
  return String(name ?? '').replace(/[^A-Za-z0-9_-]/g, '_') || 'integration';
}

/**
 * Where one launcher writes its server's stderr: `<secretsDir>/logs/integrations/<name>.<pid>.log`,
 * the name reduced to [A-Za-z0-9_-]. One file per launcher (so per thread): nothing is shared.
 */
export function integrationLogPath(secretsDir: string, name: string | undefined, pid = process.pid): string {
  return path.join(secretsDir, 'logs', 'integrations', `${safeLogName(name)}.${pid}.log`);
}

/**
 * This launcher's own log, dir 0700 and file 0600, created with O_EXCL (a leftover at the path is
 * from an earlier process that had our pid, so it is replaced). Only this launcher writes it, so
 * rotation needs no lock: past `cap` it renames to `.1` (0600) and reopens the active path at
 * once, so the path the harness line names always exists. Write errors are dropped: a full disk
 * must never stop the server.
 */
export function openIntegrationLog(file: string, cap = LOG_CAP): { write: (text: string) => void; close: () => void } {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const create = (): number => {
    let fd: number;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      fs.unlinkSync(file);
      fd = fs.openSync(file, 'wx', 0o600);
    }
    fs.fchmodSync(fd, 0o600);
    return fd;
  };
  let fd = create();
  let size = 0;
  return {
    write: (text) => {
      if (fd < 0) return;
      try {
        size += fs.writeSync(fd, text);
        if (size > cap) {
          fs.closeSync(fd);
          fd = -1;
          fs.renameSync(file, `${file}.1`);
          fs.chmodSync(`${file}.1`, 0o600);
          fd = create();
          size = 0;
        }
      } catch { /* dropped */ }
    },
    close: () => {
      try { if (fd >= 0) fs.closeSync(fd); } catch { /* ignore */ }
      fd = -1;
    },
  };
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Retention, run when a launcher starts (best effort: it never throws). For this integration
 * only, with names parsed strictly (`<name>.<pid>.log` and `<name>.<pid>.log.1`; anything else,
 * and anything not a plain file, is skipped): a log whose pid is alive is never touched; of the
 * dead launchers' runs (a run's `.log` and `.log.1` together) the 5 newest by mtime are kept, and
 * any run older than 7 days is deleted. Kept files are tightened to 0600. The shared
 * `<name>.log` / `<name>.log.1` of earlier builds are abandoned and deleted.
 */
export function pruneIntegrationLogs(secretsDir: string, name: string | undefined, now = Date.now()): void {
  const dir = path.join(secretsDir, 'logs', 'integrations');
  const safe = safeLogName(name);
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return; }
  const own = new RegExp(`^${safe}\\.(\\d+)\\.log(\\.1)?$`);
  const legacy = new Set([`${safe}.log`, `${safe}.log.1`]);
  const runs = new Map<number, { files: string[]; newest: number }>();
  for (const entry of entries) {
    const file = path.join(dir, entry);
    let st: fs.Stats;
    try { st = fs.lstatSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    if (legacy.has(entry)) { try { fs.unlinkSync(file); } catch { /* ignore */ } continue; }
    const m = own.exec(entry);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pidAlive(pid)) continue;
    const run = runs.get(pid) ?? { files: [], newest: 0 };
    run.files.push(file);
    run.newest = Math.max(run.newest, st.mtimeMs);
    runs.set(pid, run);
  }
  [...runs.values()].sort((a, b) => b.newest - a.newest).forEach((run, i) => {
    const drop = i >= KEEP_DEAD_RUNS || now - run.newest > MAX_DEAD_AGE_MS;
    for (const file of run.files) {
      try { if (drop) fs.unlinkSync(file); else fs.chmodSync(file, 0o600); } catch { /* ignore */ }
    }
  });
}

/** An error's code (ENOENT, EACCES, …) — its message can quote env values, so it is never printed. */
function errorCode(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'failed';
}

function startFailure(spec: LaunchSpec, command: string, e: unknown): string {
  return `${label(spec)}: could not start ${command}: ${errorCode(e)}`;
}

function describeExit(x: LauncherExit): string {
  return x.signal ? `exited on signal ${x.signal}` : `exited with code ${x.code}`;
}

const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

function runChild(plan: LaunchPlan, spec: LaunchSpec, secretsDir: string, baseEnv: NodeJS.ProcessEnv, spawn: typeof nodeSpawn, stderr: (line: string) => void, redact: (line: string) => string): Promise<LauncherExit> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof nodeSpawn>;
    try {
      // stdin and stdout are the MCP channel and pass through untouched. stderr goes to the
      // integration's own 0600 log, never to the harness (which keeps MCP stderr in its logs).
      child = spawn(plan.command, plan.args, { stdio: ['inherit', 'inherit', 'pipe'], env: { ...baseEnv, ...plan.env } });
    } catch (e) {
      stderr(startFailure(spec, plan.command, e));
      resolve({ code: 1, signal: null });
      return;
    }
    const forward = (signal: NodeJS.Signals) => { try { child.kill(signal); } catch { /* already gone */ } };
    for (const s of FORWARDED) process.on(s, forward);
    const logFile = integrationLogPath(secretsDir, spec.name);
    let log: ReturnType<typeof openIntegrationLog> | null = null;
    let exited: LauncherExit | null = null;
    let startFailed = false;
    let drained = !child.stderr;
    let settled = false;
    const settle = () => {
      if (settled || !exited || !drained) return;
      settled = true;
      for (const s of FORWARDED) process.off(s, forward);
      log?.write(`--- ${new Date().toISOString()} pid ${process.pid}: ${describeExit(exited)} ---\n`);
      log?.close();
      // The harness hears only this fixed line, and only when the server did not exit cleanly.
      if (!startFailed && (exited.code !== 0 || exited.signal)) {
        stderr(`${label(spec)}: ${describeExit(exited)}${log ? `; its stderr is in ${logFile}` : ''}`);
      }
      resolve(exited);
    };
    let flush = () => {};
    const drain = () => { if (drained) return; flush(); drained = true; settle(); };
    if (child.stderr) {
      try { pruneIntegrationLogs(secretsDir, spec.name); } catch { /* retention is best effort */ }
      try {
        log = openIntegrationLog(logFile);
        log.write(`--- ${new Date().toISOString()} pid ${process.pid}: started ---\n`);
      } catch (e) {
        stderr(`${label(spec)}: could not open its log ${logFile} (${errorCode(e)}); its stderr is discarded`);
      }
      flush = pipeRedacted(child.stderr, redact, (text) => log?.write(text));
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
      if (!exited) { startFailed = true; exited = { code: 127, signal: null }; }
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

  return runChild(buildLaunch(spec, values), spec, secretsDir, env, deps.spawn ?? nodeSpawn, stderr, redactor(Object.values(values)));
}

/**
 * End the launcher once its stderr queue has reached the pipe. On macOS a pipe write is async,
 * so process.exit() or a self-kill would drop a queued line when the harness reads slowly —
 * such as the "exited with code N" line. An empty write's callback runs after every earlier
 * write; the fallback stops a harness that never reads from holding us open forever.
 */
function afterStderrFlush(end: () => void): void {
  let ended = false;
  const once = () => { if (!ended) { ended = true; end(); } };
  setTimeout(once, 5000).unref();
  process.stderr.write('', once);
}

// Run only as the entry point (`node dist/integrations/launcher.js`), not when imported.
if (process.argv[1] && /integrations[\\/]launcher\.(js|mjs|ts)$/.test(process.argv[1])) {
  void runLauncher(process.argv.slice(2)).then(({ code, signal }) => afterStderrFlush(() => {
    if (signal) {
      // Our forwarding handlers are gone, so this ends us the same way the child ended.
      process.exitCode = 1;
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  }));
}
