import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { PluginRegistry, PluginRow } from './registry.js';
import type { ThreadEvents, ThreadEvent } from './thread-events.js';
import { redactThreadEvent } from './thread-events.js';
import { parseCron, cronMatches, nextCronRun, type CronSpec } from './cron.js';
import { childEnv } from '../platform/inherited-env.js';

/**
 * Plugin workers (docs/superpowers/specs/2026-11-07-plugins-design.md, section 4): one child
 * process per enabled plugin with `worker.command`, started in the plugin folder with the
 * daemon's filtered env plus the plugin identity, its key file, the API address and a socket
 * path. It restarts on exit with backoff and stays down after too many crashes in a row. Its
 * stdout and stderr go to `<logDir>/plugins/<id>.log`, rotated at LOG_MAX_BYTES.
 *
 * The daemon feeds the worker on its STDIN as NDJSON: the thread events (redacted like hook
 * scripts without `read:prompts`), the plugin's own `plugin:data` and `plugin:settings`, and
 * `plugin:job { id }` on a job's cron minute. No key opens a WebSocket (spec 6.4), so the feed
 * replaces the event socket for a worker. A worker that does not read is never waited for:
 * writes queue up to QUEUE_MAX lines and the oldest drop.
 */
export interface WorkerStats {
  state: 'running' | 'backoff' | 'stopped' | 'crashed';
  pid: number | null;
  restarts: number;
  startedAt: string | null;
  lastExit: { code: number | null; signal: string | null; at: string } | null;
  /** The socket path the worker was given; null until a listener is there. */
  socket: string | null;
  /** Lines waiting for the worker to read its stdin, and their size. */
  queued: number;
  queuedBytes: number;
}

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
const QUEUE_MAX = 500;
/** The feed queue is bounded in bytes too: a deaf worker must not hold the daemon's memory. */
export const QUEUE_MAX_BYTES = 4 * 1024 * 1024;
const LINE_MAX_BYTES = 1024 * 1024;
const STOP_GRACE_MS = 3000;
/** A Unix socket path is short: 104 bytes on macOS, 108 on Linux (with the terminator). */
export const SOCKET_PATH_MAX = 100;
/**
 * The worker's socket path: `<runDir>/plugin-<id>.sock`, or, when that would be too long for a
 * Unix socket (a long home folder, a long id), a hashed name in a private folder under the
 * system temp dir. The folder is 0700, so only this user's processes can reach the socket.
 */
export function socketPathFor(runDir: string, id: string): string {
  const plain = path.join(runDir, `plugin-${id}.sock`);
  if (Buffer.byteLength(plain) <= SOCKET_PATH_MAX) return plain;
  const h = createHash('sha256').update(`${runDir}\n${id}`).digest('hex').slice(0, 12);
  return path.join(privateRunDir(), `${h}.sock`);
}
/**
 * A folder under the temp dir that is this user's and closed to others (0700). A folder another
 * local user made first (a shared /tmp) is refused: a socket there could be swapped for theirs.
 */
function privateRunDir(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  for (const name of ['dispatch-run', `dispatch-run-${uid}`]) {
    const dir = path.join(realTmp(), name);
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch { /* exists: checked below */ }
    try {
      const st = fs.statSync(dir);
      if (st.isDirectory() && (uid < 0 || st.uid === uid) && (st.mode & 0o777) === 0o700) return dir;
    } catch { /* try the next */ }
  }
  return fs.mkdtempSync(path.join(realTmp(), 'dispatch-run-'));
}
function realTmp(): string { try { return fs.realpathSync(os.tmpdir()); } catch { return os.tmpdir(); } }

const DEFAULT_BACKOFF = (n: number): number => Math.min(60_000, 1000 * 2 ** Math.max(0, n - 1));

interface Worker {
  id: string;
  child: ChildProcess | null;
  state: WorkerStats['state'];
  restarts: number;
  crashes: number;
  startedAt: number | null;
  lastExit: WorkerStats['lastExit'];
  socket: string;
  queue: string[];
  queueBytes: number;
  readPrompts: boolean;
  blocked: boolean;
  stopping: boolean;
  timer: NodeJS.Timeout | null;
  log: fs.WriteStream | null;
  logBytes: number;
  fired: Map<string, number>;
}

export class PluginWorkers {
  private workers = new Map<string, Worker>();
  private readonly unsubscribe: () => void;
  private readonly untap: () => void;
  private readonly logDir: string;
  private readonly runDir: string;
  private readonly api: string | (() => string);
  private readonly backoffMs: (n: number) => number;
  private readonly maxCrashes: number;
  private readonly healthyMs: number;
  private ticker: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly registry: PluginRegistry, events: ThreadEvents, opts: { logDir: string; runDir: string; api: string | (() => string); backoffMs?: (n: number) => number; maxCrashes?: number; healthyMs?: number; tickMs?: number | null }) {
    this.logDir = path.join(opts.logDir, 'plugins');
    this.runDir = opts.runDir;
    this.api = opts.api;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF;
    this.maxCrashes = opts.maxCrashes ?? 10;
    this.healthyMs = opts.healthyMs ?? 60_000;
    this.unsubscribe = events.subscribe((e) => this.onThreadEvent(e));
    this.untap = registry.tapBroadcast((e) => this.onPluginEvent(e));
    if (opts.tickMs !== null) {
      this.ticker = setInterval(() => this.tick(new Date()), opts.tickMs ?? 30_000);
      this.ticker.unref?.();
    }
  }

  /** Start the enabled, keyed plugins that have a worker; stop every other worker. */
  sync(): void {
    if (this.stopped) return;
    const wanted = new Set<string>();
    for (const row of this.registry.list()) {
      if (!row.worker || !row.enabled || row.error || !row.keyed) continue;
      wanted.add(row.id);
      const w = this.workers.get(row.id);
      if (!w || (w.state === 'stopped' && !w.stopping)) this.start(row);
    }
    for (const [id, w] of this.workers) if (!wanted.has(id) && w.state !== 'stopped') void this.stopOne(w);
  }

  stats(id: string): WorkerStats | null {
    const w = this.workers.get(id);
    if (!w) return null;
    return {
      state: w.state, pid: w.child?.pid ?? null, restarts: w.restarts,
      startedAt: w.startedAt ? new Date(w.startedAt).toISOString() : null, lastExit: w.lastExit,
      socket: fs.existsSync(w.socket) ? w.socket : null, queued: w.queue.length, queuedBytes: w.queueBytes,
    };
  }

  /** The owner's Restart: a fresh start, the crash count forgotten. */
  restart(id: string): void {
    if (this.stopped) return;
    const w = this.workers.get(id);
    if (w) { w.crashes = 0; w.restarts = 0; if (w.timer) { clearTimeout(w.timer); w.timer = null; } }
    const wanted = (): PluginRow | null => { const row = this.registry.get(id); return row?.worker && row.enabled && !row.error && row.keyed ? row : null; };
    if (w?.child?.pid) { w.stopping = true; ee(w.child).once('exit', () => { w.stopping = false; const row = wanted(); if (row) this.start(row); }); this.kill(w); return; }
    const row = wanted();
    if (row) this.start(row);
  }

  /** The last `lines` lines of the plugin's log. */
  logTail(id: string, lines = 200): string {
    const file = path.join(this.logDir, `${id}.log`);
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return ''; }
    const all = text.split('\n');
    if (all[all.length - 1] === '') all.pop();
    return all.slice(-Math.max(1, lines)).join('\n') + (all.length ? '\n' : '');
  }

  /** The jobs the running workers will fire by themselves, and the soonest next minute (idle info, os/idle-info.ts). */
  scheduledJobs(now: Date = new Date()): { count: number; nextRunAt: string | null } {
    let count = 0;
    let next: number | null = null;
    for (const [id, w] of this.workers) {
      if (w.state !== 'running') continue;
      for (const job of this.registry.get(id)?.worker?.jobs ?? []) {
        const spec = specOf(job.cron);
        if (!spec) continue;
        count++;
        const at = nextCronRun(spec, now);
        if (at && (next === null || at.getTime() < next)) next = at.getTime();
      }
    }
    return { count, nextRunAt: next === null ? null : new Date(next).toISOString() };
  }

  /** Fire the jobs whose cron matches this minute (once per minute per job). */
  tick(now: Date): void {
    const minute = Math.floor(now.getTime() / 60_000);
    for (const [id, w] of this.workers) {
      if (w.state !== 'running') continue;
      const row = this.registry.get(id);
      for (const job of row?.worker?.jobs ?? []) {
        const spec = specOf(job.cron);
        if (!spec || !cronMatches(spec, now) || w.fired.get(job.id) === minute) continue;
        w.fired.set(job.id, minute);
        this.write(w, { type: 'plugin:job', id: job.id, at: now.toISOString() });
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe(); this.untap();
    if (this.ticker) clearInterval(this.ticker);
    await Promise.all([...this.workers.values()].map((w) => this.stopOne(w)));
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────────────────
  private start(row: PluginRow): void {
    const folder = this.registry.folderPath(row.id);
    const spec = row.worker;
    if (!folder || !spec) return;
    let w = this.workers.get(row.id);
    if (!w) {
      w = { id: row.id, child: null, state: 'stopped', restarts: 0, crashes: 0, startedAt: null, lastExit: null, socket: socketPathFor(this.runDir, row.id), queue: [], queueBytes: 0, readPrompts: false, blocked: false, stopping: false, timer: null, log: null, logBytes: 0, fired: new Map() };
      this.workers.set(row.id, w);
    }
    if (w.child) return;
    try { fs.mkdirSync(this.runDir, { recursive: true, mode: 0o700 }); } catch { /* exists */ }
    try { fs.unlinkSync(w.socket); } catch { /* none */ }
    const keyFile = this.registry.keyFilePath(row.id);
    const env: NodeJS.ProcessEnv = childEnv(spec.env, {
      DISPATCH_PLUGIN: row.id, ...(keyFile ? { DISPATCH_PLUGIN_AUTH_FILE: keyFile } : {}),
      DISPATCH_API: typeof this.api === 'function' ? this.api() : this.api, DISPATCH_PLUGIN_SOCKET: w.socket,
    });
    this.openLog(w);
    let child: ChildProcess;
    try {
      child = spawn(spec.command, spec.args, { cwd: folder, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.logLine(w, `[dispatch] cannot start the worker: ${e instanceof Error ? e.message : String(e)}`);
      this.onExit(w, null, null);
      return;
    }
    w.child = child; w.state = 'running'; w.startedAt = Date.now(); w.blocked = false;
    w.readPrompts = (row.permissions ?? []).includes('read:prompts');
    child.stdout?.on('data', (c: Buffer) => this.logChunk(w!, c));
    child.stderr?.on('data', (c: Buffer) => this.logChunk(w!, c));
    child.stdin?.on('error', () => { /* the worker closed its stdin; the queue just waits */ });
    child.stdin?.on('drain', () => { w!.blocked = false; this.flush(w!); });
    ee(child).on('error', (e: Error) => {
      this.logLine(w!, `[dispatch] cannot start the worker: ${e.message}`);
      // A command that cannot run (ENOENT, EACCES) emits `error` and never `exit`: count it as a crash here.
      if (w!.child === child && child.pid === undefined) { w!.child = null; this.onExit(w!, null, null); }
    });
    ee(child).on('exit', (code: number | null, signal: string | null) => { if (w!.child === child) this.onExit(w!, code, signal); });
    this.flush(w);
  }

  private onExit(w: Worker, code: number | null, signal: string | null): void {
    const ran = w.startedAt ? Date.now() - w.startedAt : 0;
    w.child = null; w.blocked = false;
    w.lastExit = { code, signal, at: new Date().toISOString() };
    this.logLine(w, `[dispatch] worker exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`);
    try { fs.unlinkSync(w.socket); } catch { /* none */ }
    if (w.stopping || this.stopped) {
      w.state = 'stopped'; w.stopping = false; this.closeLog(w);
      // Enabled again while it was stopping: the next sync starts it.
      if (!this.stopped) queueMicrotask(() => { try { this.sync(); } catch { /* the next announce retries */ } });
      return;
    }
    if (ran >= this.healthyMs) w.crashes = 0;
    w.crashes += 1;
    if (w.crashes >= this.maxCrashes) {
      w.state = 'crashed';
      this.logLine(w, `[dispatch] the worker crashed ${w.crashes} times in a row; not restarting (Restart on the Plugins page)`);
      this.closeLog(w);
      return;
    }
    w.state = 'backoff';
    const delay = this.backoffMs(w.crashes);
    w.timer = setTimeout(() => {
      w.timer = null;
      if (this.stopped || w.stopping) { w.state = 'stopped'; return; }
      const row = this.registry.get(w.id);
      if (!row?.worker || !row.enabled || row.error || !row.keyed) { w.state = 'stopped'; return; }
      w.restarts += 1;
      this.start(row);
    }, delay);
    w.timer.unref?.();
  }

  private stopOne(w: Worker): Promise<void> {
    if (w.timer) { clearTimeout(w.timer); w.timer = null; }
    if (!w.child?.pid) { w.child = null; w.state = 'stopped'; this.closeLog(w); return Promise.resolve(); }
    w.stopping = true;
    return new Promise((resolve) => { ee(w.child!).once('exit', () => resolve()); this.kill(w); });
  }

  private kill(w: Worker): void {
    const child = w.child;
    if (!child) return;
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, STOP_GRACE_MS);
    // While the daemon shuts down the timer stays referenced: a worker that ignores SIGTERM is killed before the daemon goes.
    if (!this.stopped) hard.unref?.();
    ee(child).once('exit', () => clearTimeout(hard));
  }

  // ── the feed ─────────────────────────────────────────────────────────────────────────────
  private onThreadEvent(e: ThreadEvent): void {
    for (const w of this.workers.values()) {
      if (w.state !== 'running') continue;
      this.write(w, w.readPrompts ? e : redactThreadEvent(e));
    }
  }

  private onPluginEvent(e: Record<string, unknown>): void {
    if ((e.type !== 'plugin:data' && e.type !== 'plugin:settings') || typeof e.id !== 'string') return;
    const w = this.workers.get(e.id);
    if (w && w.state === 'running') this.write(w, e);
  }

  private write(w: Worker, event: unknown): void {
    let line: string;
    try { line = JSON.stringify(event) + '\n'; } catch { return; }
    const bytes = Buffer.byteLength(line);
    if (bytes > LINE_MAX_BYTES) { this.logLine(w, `[dispatch] dropped a ${String((event as { type?: unknown })?.type ?? 'line')} line of ${bytes} bytes (over the ${LINE_MAX_BYTES} byte line cap)`); return; }
    w.queue.push(line); w.queueBytes += bytes;
    while (w.queue.length > QUEUE_MAX || w.queueBytes > QUEUE_MAX_BYTES) { const dropped = w.queue.shift()!; w.queueBytes -= Buffer.byteLength(dropped); }
    this.flush(w);
  }

  private flush(w: Worker): void {
    const stdin = w.child?.stdin;
    if (!stdin || !stdin.writable || w.blocked) return;
    while (w.queue.length > 0) {
      const line = w.queue.shift()!;
      w.queueBytes -= Buffer.byteLength(line);
      let ok = true;
      try { ok = stdin.write(line); } catch { return; }
      if (!ok) { w.blocked = true; return; }
    }
  }

  // ── logs ─────────────────────────────────────────────────────────────────────────────────
  private logFile(w: Worker): string { return path.join(this.logDir, `${w.id}.log`); }

  private openLog(w: Worker): void {
    if (w.log) return;
    try { fs.mkdirSync(this.logDir, { recursive: true }); } catch { /* exists */ }
    const file = this.logFile(w);
    try { w.logBytes = fs.statSync(file).size; } catch { w.logBytes = 0; }
    if (w.logBytes > LOG_MAX_BYTES) this.rotate(w);
    w.log = fs.createWriteStream(file, { flags: 'a' });
    w.log.on('error', () => { /* a full disk must not take the daemon down */ });
  }

  private rotate(w: Worker): void {
    const file = this.logFile(w);
    if (w.log) { w.log.end(); w.log = null; }
    try { fs.renameSync(file, `${file}.1`); } catch { /* nothing to rotate */ }
    w.logBytes = 0;
  }

  private logChunk(w: Worker, chunk: Buffer): void {
    if (!w.log) this.openLog(w);
    if (w.logBytes + chunk.length > LOG_MAX_BYTES) { this.rotate(w); this.openLog(w); }
    w.logBytes += chunk.length;
    w.log?.write(chunk);
  }

  private logLine(w: Worker, text: string): void { this.logChunk(w, Buffer.from(`${new Date().toISOString()} ${text}\n`)); }

  private closeLog(w: Worker): void { if (w.log) { w.log.end(); w.log = null; } }
}

/** The child as an emitter: the typings of ChildProcess hide `on`/`once`. */
const ee = (c: ChildProcess): NodeJS.EventEmitter => c as unknown as NodeJS.EventEmitter;

const specs = new Map<string, CronSpec | null>();
function specOf(cron: string): CronSpec | null {
  if (!specs.has(cron)) specs.set(cron, parseCron(cron));
  return specs.get(cron) ?? null;
}
