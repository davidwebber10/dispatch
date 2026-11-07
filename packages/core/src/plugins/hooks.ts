import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { PluginRegistry, PluginRow } from './registry.js';
import type { ThreadEvents, ThreadEvent } from './thread-events.js';
import type { HookEvent } from './manifest.js';
import { redactThreadEvent } from './thread-events.js';

/**
 * Hook scripts (docs/superpowers/specs/2026-11-07-plugins-design.md, section 3.3): for every
 * enabled plugin with `model.hooks`, the daemon runs the plugin's script for each thread event
 * of that kind, with the event as JSON on stdin and the plugin's identity in the environment.
 * One script at a time per plugin; a backlog cap drops the oldest; a timeout kills a hang. A
 * plugin without `read:prompts` gets the redacted event (lengths, no text).
 */
export interface HookStats { runs: number; failures: number; dropped: number }

const EVENT_HOOK: Record<ThreadEvent['type'], HookEvent> = {
  'thread:prompt': 'prompt', 'thread:tool': 'toolCall', 'thread:turn': 'turnEnd', 'thread:spawned': 'spawn', 'thread:status': 'status',
};

interface Queue { pending: ThreadEvent[]; running: boolean }

export class PluginHooks {
  private queues = new Map<string, Queue>();
  private statsById = new Map<string, HookStats>();
  private unsubscribe: () => void;
  private readonly timeoutMs: number;
  private readonly backlog: number;
  private readonly api: string | (() => string);
  private waiters: (() => void)[] = [];
  private stopped = false;

  constructor(private readonly registry: PluginRegistry, events: ThreadEvents, opts: { timeoutMs?: number; backlog?: number; api: string | (() => string) }) {
    this.timeoutMs = opts.timeoutMs ?? 10000;
    this.backlog = opts.backlog ?? 100;
    this.api = opts.api;
    this.unsubscribe = events.subscribe((e) => this.onEvent(e));
  }

  stats(id: string): HookStats { return { ...(this.statsById.get(id) ?? { runs: 0, failures: 0, dropped: 0 }) }; }

  stop(): void { this.stopped = true; this.unsubscribe(); }

  /** Resolves once every queued script has run (tests). */
  idle(): Promise<void> {
    if ([...this.queues.values()].every((q) => !q.running && q.pending.length === 0)) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  private onEvent(e: ThreadEvent): void {
    if (this.stopped) return;
    for (const row of this.registry.list()) {
      const hook = row.model?.hooks?.[EVENT_HOOK[e.type]];
      if (!hook || !row.enabled || row.error) continue;
      if (e.type === 'thread:tool' && hook.tools && hook.tools.length > 0 && !hook.tools.some((g) => matchGlob(g, e.tool))) continue;
      const q = this.queues.get(row.id) ?? { pending: [], running: false };
      this.queues.set(row.id, q);
      q.pending.push(e);
      if (q.pending.length > this.backlog) {
        q.pending.splice(0, q.pending.length - this.backlog);
        this.bump(row.id, 'dropped');
      }
      void this.drain(row.id);
    }
  }

  private bump(id: string, field: keyof HookStats): void {
    const s = this.statsById.get(id) ?? { runs: 0, failures: 0, dropped: 0 };
    s[field] += 1;
    this.statsById.set(id, s);
  }

  private async drain(id: string): Promise<void> {
    const q = this.queues.get(id);
    if (!q || q.running) return;
    q.running = true;
    try {
      while (q.pending.length > 0 && !this.stopped) {
        const e = q.pending.shift()!;
        const row = this.registry.get(id);
        const hook = row?.model?.hooks?.[EVENT_HOOK[e.type]];
        if (!row || !row.enabled || row.error || !hook) continue;
        await this.run(row, hook.run, e);
      }
    } finally {
      q.running = false;
      if ([...this.queues.values()].every((x) => !x.running && x.pending.length === 0)) {
        const w = this.waiters; this.waiters = [];
        for (const r of w) r();
      }
    }
  }

  private run(row: PluginRow, script: string, e: ThreadEvent): Promise<void> {
    return new Promise((resolve) => {
      const folder = this.registry.folderPath(row.id);
      if (!folder) { resolve(); return; }
      const file = path.join(folder, script);
      const canReadPrompts = (row.permissions ?? []).includes('read:prompts');
      const payload = JSON.stringify(canReadPrompts ? e : redactThreadEvent(e));
      const keyFile = path.join(path.dirname(this.registry.dir), 'keys', `plugin-${row.id}`);
      const env: NodeJS.ProcessEnv = {
        ...process.env, DISPATCH_PLUGIN: row.id, DISPATCH_PLUGIN_AUTH_FILE: keyFile, DISPATCH_API: typeof this.api === 'function' ? this.api() : this.api,
        DISPATCH_TERMINAL: e.terminalId, DISPATCH_SESSION: e.sessionId, DISPATCH_EVENT: e.type,
      };
      this.bump(row.id, 'runs');
      let done = false;
      const finish = (failed: boolean) => { if (done) return; done = true; clearTimeout(timer); if (failed) this.bump(row.id, 'failures'); resolve(); };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(process.execPath, [file], { cwd: folder, env, stdio: ['pipe', 'ignore', 'pipe'] });
      } catch { finish(true); return; }
      const ee = child as unknown as NodeJS.EventEmitter;
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(true); }, this.timeoutMs);
      let stderr = '';
      child.stderr?.on('data', (c) => { if (stderr.length < 4096) stderr += String(c); });
      ee.on('error', () => finish(true));
      ee.on('exit', (code: number | null) => {
        if (code !== 0 && stderr) console.warn(`[plugin ${row.id}] hook ${script} exited ${code}: ${stderr.trim().slice(0, 300)}`);
        finish(code !== 0);
      });
      child.stdin?.on('error', () => { /* the script closed stdin early */ });
      child.stdin?.end(payload);
    });
  }
}

/** `Bash`, `mcp__dispatch__*`, `*`: a glob with `*` only. */
export function matchGlob(glob: string, name: string): boolean {
  const re = new RegExp('^' + glob.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(name);
}
