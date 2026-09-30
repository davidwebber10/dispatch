import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'child_process'; // unprefixed: see setup/install.ts
import { toolPaths, hostOsFamily } from './paths.js';
import { loadManifest } from './manifest.js';
import type { ToolEntry, AuthCheckOutcome } from './types.js';

export type { AuthCheckOutcome } from './types.js';

/** Runs one auth check and reports how it ended — never what it printed. An exit code in
 *  `unknownExitCodes` means the check could not tell, so it is 'unknown', not 'failed'. */
export type AuthCheckRunner = (cmd: string, args: string[], opts: { env: Record<string, string>; signal: AbortSignal; cwd?: string; unknownExitCodes?: number[] }) => Promise<AuthCheckOutcome>;

export interface ToolAuthSnapshot { results: Record<string, AuthCheckOutcome>; checkedAt: string | null; }

export interface ToolAuthProberOptions {
  base?: string;
  /** Env the thread spawn env is layered on. Defaults to process.env, as a thread's is. */
  env?: Record<string, string | undefined>;
  run?: AuthCheckRunner;
  /** Working dir for the checks; the daemon's own when omitted. */
  cwd?: string;
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Default runner. All three streams are 'ignore': nothing a check prints is read, logged, or
 * returned (these commands print account ids, and some print tokens), and stdin at EOF makes a
 * CLI that wants to prompt fail fast instead of hanging. Detached, so the check leads its own
 * process group: an abort kills a shell check's children too, not just /bin/sh, and whatever a
 * check leaves running when it exits (the aws scan stops at its first success) is killed then.
 */
export const runQuiet: AuthCheckRunner = (cmd, args, { env, signal, cwd, unknownExitCodes }) => new Promise((resolve) => {
  const detached = process.platform !== 'win32';
  let child: ChildProcess;
  try { child = spawn(cmd, args, { env, cwd, stdio: 'ignore', detached }); }
  catch { resolve('unknown'); return; }
  const kill = () => {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  };
  const settle = (o: AuthCheckOutcome) => { signal.removeEventListener('abort', kill); resolve(o); };
  if (signal.aborted) kill(); else signal.addEventListener('abort', kill, { once: true });
  child.on('error', () => settle('unknown'));
  child.on('exit', (code) => {
    if (detached) { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* nothing left in the group */ } }
    // code null = ended by a signal; unknownExitCodes = the check itself says it could not tell
    settle(code === 0 ? 'ok' : code === null || unknownExitCodes?.includes(code) ? 'unknown' : 'failed');
  });
});

interface CachedRun { results: Record<string, AuthCheckOutcome>; checkedAtMs: number; envKey: string; }

/**
 * Whether each installed CLI can actually sign in from a thread. The daemon's own env is not
 * the answer: launchd hands it little more than PATH, while a thread also gets the Settings →
 * Secrets env, and most CLIs keep their login in a keyring or config file anyway. So each
 * entry's `authCheck` runs with the THREAD env, and the answer is cached — awarenessNote is
 * sync and can only ever read the cache.
 *
 * The cache belongs to the env it was checked with (a fingerprint of it, so an equal env from
 * a fresh refreshPtyEnv keeps it). Once the thread env changes — a Doppler disconnect, a new
 * secret — the old answer is dropped. A generation counter, bumped by every env change and
 * every run start, lets only the newest run publish: an older run cannot overwrite a newer
 * answer, even one for the same env (A → B → A).
 */
export class ToolAuthProber {
  private cached: CachedRun | null = null;
  private inFlight: { envKey: string; generation: number; promise: Promise<ToolAuthSnapshot> } | null = null;
  private generation = 0;
  private lastEnvKey: string | null = null;
  private spawnEnv: Record<string, string> = {};
  private readonly base?: string;
  private readonly env?: Record<string, string | undefined>;
  private readonly run: AuthCheckRunner;
  private readonly cwd?: string;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(opts: ToolAuthProberOptions = {}) {
    this.base = opts.base;
    this.env = opts.env;
    this.run = opts.run ?? runQuiet;
    this.cwd = opts.cwd;
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.now = opts.now ?? Date.now;
  }

  /** The spawn env threads get (refreshPtyEnv in server.ts); the latest one wins. */
  setSpawnEnv(env: Record<string, string>): void {
    this.spawnEnv = env;
    const envKey = fingerprint(this.threadEnv());
    if (envKey !== this.lastEnvKey) { this.lastEnvKey = envKey; this.generation++; }
  }

  threadEnv(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...(this.env ?? process.env), ...this.spawnEnv })) if (v !== undefined) out[k] = v;
    return out;
  }

  snapshot(): ToolAuthSnapshot {
    const c = this.current();
    return c ? { results: { ...c.results }, checkedAt: new Date(c.checkedAtMs).toISOString() } : { results: {}, checkedAt: null };
  }

  isStale(): boolean {
    const c = this.current();
    return !c || this.now() - c.checkedAtMs > this.ttlMs;
  }

  /**
   * Re-run every check. Callers share a run only while it is still the newest and checks the
   * env they see now — a "Check again" after an env change starts its own. Never throws.
   */
  refresh(): Promise<ToolAuthSnapshot> {
    const env = this.threadEnv();
    const envKey = fingerprint(env);
    const f = this.inFlight;
    if (f && f.generation === this.generation && f.envKey === envKey) return f.promise;
    const generation = ++this.generation;
    const promise: Promise<ToolAuthSnapshot> = this.runAll(env, envKey, generation)
      .finally(() => { if (this.inFlight?.promise === promise) this.inFlight = null; });
    this.inFlight = { envKey, generation, promise };
    return promise;
  }

  /** The cached run, if it was checked with the thread env as it is now. */
  private current(): CachedRun | null {
    return this.cached && this.cached.envKey === fingerprint(this.threadEnv()) ? this.cached : null;
  }

  private async runAll(env: Record<string, string>, envKey: string, generation: number): Promise<ToolAuthSnapshot> {
    try {
      const p = toolPaths(this.base);
      const family = hostOsFamily();
      const entries = loadManifest(this.base).filter((e) => e.authCheck
        && (!e.platforms || e.platforms.includes(family))
        && e.bins.every((b) => fs.existsSync(path.join(p.bin, b))));
      const outcomes = await Promise.all(entries.map((e) => this.check(e, p.bin, env)));
      const results: Record<string, AuthCheckOutcome> = {};
      entries.forEach((e, i) => { results[e.name] = outcomes[i]; });
      // Publish only as the newest run, under the env it checked. Otherwise the env moved on
      // or a newer run owns the answer: leave the cache alone.
      if (generation === this.generation && fingerprint(this.threadEnv()) === envKey) this.cached = { results, checkedAtMs: this.now(), envKey };
    } catch { /* keep the last answer */ }
    return this.snapshot();
  }

  /** One check, raced against its timeout. A timeout aborts the run and is 'unknown'. */
  private check(e: ToolEntry, binDir: string, env: Record<string, string>): Promise<AuthCheckOutcome> {
    const c = e.authCheck!;
    const [cmd, args] = c.shell !== undefined ? ['/bin/sh', ['-c', c.shell]] : [path.join(binDir, e.bins[0]), c.args ?? []];
    const ac = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<AuthCheckOutcome>((resolve) => {
      timer = setTimeout(() => { ac.abort(); resolve('unknown'); }, c.timeoutMs ?? this.timeoutMs);
    });
    const ran = Promise.resolve()
      .then(() => this.run(cmd, args, { env, signal: ac.signal, cwd: this.cwd, unknownExitCodes: c.unknownExitCodes }))
      .then((o): AuthCheckOutcome => (o === 'ok' || o === 'failed' ? o : 'unknown'), (): AuthCheckOutcome => 'unknown');
    return Promise.race([ran, timedOut]).finally(() => clearTimeout(timer));
  }
}

/** A stable digest of an env, so an equal env rebuilt as a new object still matches. */
function fingerprint(env: Record<string, string>): string {
  const h = crypto.createHash('sha256');
  for (const k of Object.keys(env).sort()) h.update(`${k}\0${env[k]}\0`);
  return h.digest('hex');
}
