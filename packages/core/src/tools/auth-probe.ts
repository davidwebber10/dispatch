import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'child_process'; // unprefixed: see setup/install.ts
import { toolPaths, hostOsFamily } from './paths.js';
import { loadManifest } from './manifest.js';
import type { ToolEntry } from './types.js';

/** Runs one auth check. Resolves true only on exit 0, and never exposes what the check printed. */
export type AuthCheckRunner = (cmd: string, args: string[], opts: { env: Record<string, string>; signal: AbortSignal; cwd?: string }) => Promise<boolean>;

export interface ToolAuthSnapshot { results: Record<string, boolean>; checkedAt: string | null; }

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
 * process group and an abort kills a shell check's children too, not just /bin/sh.
 */
export const runQuiet: AuthCheckRunner = (cmd, args, { env, signal, cwd }) => new Promise((resolve) => {
  let child: ChildProcess;
  try { child = spawn(cmd, args, { env, cwd, stdio: 'ignore', detached: process.platform !== 'win32' }); }
  catch { resolve(false); return; }
  const kill = () => {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  };
  const settle = (ok: boolean) => { signal.removeEventListener('abort', kill); resolve(ok); };
  if (signal.aborted) kill(); else signal.addEventListener('abort', kill, { once: true });
  child.on('error', () => settle(false));
  child.on('exit', (code) => settle(code === 0));
});

/**
 * Whether each installed CLI can actually sign in from a thread. The daemon's own env is not
 * the answer: launchd hands it little more than PATH, while a thread also gets the Settings →
 * Secrets env, and most CLIs keep their login in a keyring or config file anyway. So each
 * entry's `authCheck` runs with the THREAD env, and the answer is cached — awarenessNote is
 * sync and can only ever read the cache.
 */
export class ToolAuthProber {
  private state: ToolAuthSnapshot = { results: {}, checkedAt: null };
  private checkedAtMs: number | null = null;
  private inFlight: Promise<ToolAuthSnapshot> | null = null;
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
  setSpawnEnv(env: Record<string, string>): void { this.spawnEnv = env; }

  threadEnv(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...(this.env ?? process.env), ...this.spawnEnv })) if (v !== undefined) out[k] = v;
    return out;
  }

  snapshot(): ToolAuthSnapshot { return { results: { ...this.state.results }, checkedAt: this.state.checkedAt }; }

  isStale(): boolean { return this.checkedAtMs === null || this.now() - this.checkedAtMs > this.ttlMs; }

  /** Re-run every check. Concurrent callers share one run. Never throws. */
  refresh(): Promise<ToolAuthSnapshot> {
    if (!this.inFlight) this.inFlight = this.runAll().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async runAll(): Promise<ToolAuthSnapshot> {
    try {
      const p = toolPaths(this.base);
      const family = hostOsFamily();
      const env = this.threadEnv();
      const entries = loadManifest(this.base).filter((e) => e.authCheck
        && (!e.platforms || e.platforms.includes(family))
        && e.bins.every((b) => fs.existsSync(path.join(p.bin, b))));
      const oks = await Promise.all(entries.map((e) => this.check(e, p.bin, env)));
      const results: Record<string, boolean> = {};
      entries.forEach((e, i) => { results[e.name] = oks[i]; });
      this.checkedAtMs = this.now();
      this.state = { results, checkedAt: new Date(this.checkedAtMs).toISOString() };
    } catch { /* keep the last answer */ }
    return this.snapshot();
  }

  /** One check, raced against its timeout. A timeout aborts the run and counts as not authed. */
  private check(e: ToolEntry, binDir: string, env: Record<string, string>): Promise<boolean> {
    const c = e.authCheck!;
    const [cmd, args] = c.shell !== undefined ? ['/bin/sh', ['-c', c.shell]] : [path.join(binDir, e.bins[0]), c.args ?? []];
    const ac = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => { ac.abort(); resolve(false); }, c.timeoutMs ?? this.timeoutMs);
    });
    const ran = Promise.resolve()
      .then(() => this.run(cmd, args, { env, signal: ac.signal, cwd: this.cwd }))
      .then((ok) => ok === true, () => false);
    return Promise.race([ran, timedOut]).finally(() => clearTimeout(timer));
  }
}
