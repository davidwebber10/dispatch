// packages/core/src/os/process-reaper.ts
// Idle thread processes on a small host (spec: idle process reaper). Each open structured thread keeps
// a CLI child process (about 140 MB resident) until the daemon restarts. On a 4 GB host about 25 of them
// end the container. This file stops the processes nobody uses, and starts them again on the next message.
//
// OFF BY DEFAULT. Nothing here runs unless the host sets one of the two variables (caps.ts):
//   DISPATCH_IDLE_PROCESS_MINUTES  an idle process is stopped after this many minutes (unset or 0: off)
//   DISPATCH_MAX_LIVE_PROCESSES    a cap on live thread processes on this host; starting one more stops the
//                                  least recently used idle one first (unset or 0: off)
// A local (desktop) install sets neither, so `createProcessReaper` returns null, the daemon wires nothing,
// and the dormant set below stays empty: every check against it answers false.
//
// Stop: the normal stop of a thread (SessionService.stopTerminal: the key is revoked, the process gets
// SIGTERM, then SIGKILL). The thread is then DORMANT: an id in `dormantStops` while this daemon runs,
// and `processDormantAt` in its config so a restart keeps it dormant. A dormant stop changes nothing a
// person sees: the status stays as it was (status/service.ts markExited), no "Process exited" result is
// sent to an open chat (ws/structured.ts), and opening the thread reads the journal only (daemon/sockets.ts).
//
// Resume: the path a thread takes after a daemon restart. A message, a schedule or a coordinator notice
// reaches SessionService.sendStructuredMessage, which calls ensureStructuredAlive (resume the saved
// session with `-r <id>` and the transcript backfill), then delivers the message.
//
// Busy, never stopped: a turn is open (status working / needs_input / starting / queued / scheduled), a
// question or approval is pending, a blocked action waits, a subagent or background task runs, or the
// thread is a headless role run. Codex threads are not counted or stopped: they share one app-server
// process, which unloads an idle thread by itself.
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import { idleProcessMinutes, maxLiveProcesses } from '../caps.js';
import { ThreadConfigStore } from '../sessions/thread-config.js';
import type { IStructuredManager, StructuredSpawnOpts } from '../structured/manager.js';

/** The config key a dormant thread carries (ISO time of the stop). */
export const DORMANT_KEY = 'processDormantAt';

/** Threads stopped by this file and not started again yet (in this daemon's life). */
const dormantStops = new Set<string>();
/** When a resume of a dormant thread was asked for (epoch ms), until its first frame. */
const resumeAsked = new Map<string, number>();

/** True while a thread's process is stopped by the reaper. Always false on a host without the reaper. */
export function isDormantStop(terminalId: string): boolean {
  return dormantStops.size > 0 && dormantStops.has(terminalId);
}

/** The settings, read from the environment. Null: both are off (every local install). */
export interface ReaperSettings { idleMs: number; maxLive: number }
export function reaperSettings(): ReaperSettings | null {
  const idleMs = Math.round(idleProcessMinutes() * 60_000);
  const maxLive = maxLiveProcesses();
  return idleMs > 0 || maxLive > 0 ? { idleMs, maxLive } : null;
}

/**
 * Opening a thread starts its process (ws/structured.ts onConnect) — except a dormant thread on a host
 * with the reaper: viewing reads the journal only. Without the reaper this is always true.
 */
export function viewMayStart(config: Record<string, unknown> | null | undefined, terminalId: string, settings: ReaperSettings | null = reaperSettings()): boolean {
  if (!settings) return true;
  return !(isDormantStop(terminalId) || typeof config?.[DORMANT_KEY] === 'string');
}

/** The resume clock starts here (SessionService.ensureStructuredAlive): only for a dormant thread. */
export function noteResumeAsked(terminalId: string, config: Record<string, unknown> | null | undefined, now = Date.now()): void {
  if (isDormantStop(terminalId) || typeof config?.[DORMANT_KEY] === 'string') {
    if (!resumeAsked.has(terminalId)) resumeAsked.set(terminalId, now);
  }
}

/** Statuses of a thread with work in flight. */
const BUSY_STATUSES = new Set(['queued', 'starting', 'working', 'needs_input', 'scheduled']);
/** Subagent states that are still running. */
const RUNNING_SUBAGENT = new Set(['starting', 'working', 'needs_input']);
/** Harnesses that share one process across threads: not counted, not stopped. */
const SHARED_PROCESS_HARNESSES = new Set(['codex']);
/** How often the live count is logged even when it did not change. */
const COUNT_LOG_EVERY_MS = 5 * 60_000;

export type ReaperLog = (event: string, fields: Record<string, unknown>, level?: 'info' | 'warn') => void;

export interface ProcessReaperDeps {
  db: Database.Database;
  /** Every structured manager, by harness. */
  managers: Map<string, IStructuredManager>;
  /** The normal stop of a thread (SessionService.stopTerminal). */
  stop: (terminalId: string) => void;
  settings: ReaperSettings;
  log: ReaperLog;
  now?: () => number;
  /** Resident memory (KB) of these processes, or null when it cannot be read. */
  rssKb?: (pids: number[]) => number | null;
}

interface LiveThread { id: string; harness: string; manager: IStructuredManager }

export class ProcessReaper {
  private readonly lastUse = new Map<string, number>();
  private readonly configs: ThreadConfigStore;
  private readonly now: () => number;
  private lastCount: number | null = null;
  private lastCountAt = 0;
  private readonly undo: Array<() => void> = [];

  constructor(private readonly deps: ProcessReaperDeps) {
    this.configs = new ThreadConfigStore(deps.db);
    this.now = deps.now ?? Date.now;
  }

  get settings(): ReaperSettings { return this.deps.settings; }

  /**
   * Hook every per-process manager: each frame or sent message is use, and each spawn first makes room
   * under the cap and ends the dormant state. Returns the function that removes the hooks.
   */
  attach(): () => void {
    for (const [harness, manager] of this.deps.managers) {
      if (SHARED_PROCESS_HARNESSES.has(harness)) continue;
      const touch = (id: string) => { this.lastUse.set(id, this.now()); };
      const onEvent = (id: string, ev: unknown) => {
        touch(id);
        this.noteFirstFrame(id, harness, ev);
      };
      const onExit = (id: string) => { if (!isDormantStop(id)) this.lastUse.delete(id); };
      manager.on('busy', touch);
      manager.on('idle', touch);
      manager.on('event', onEvent);
      manager.on('permission', touch);
      manager.on('exit', onExit);
      const original = manager.spawn;
      manager.spawn = (terminalId: string, opts: StructuredSpawnOpts): number => {
        this.makeRoom(terminalId);
        const wasDormant = this.leaveDormant(terminalId);
        if (wasDormant && !resumeAsked.has(terminalId)) resumeAsked.set(terminalId, this.now());
        const pid = original.call(manager, terminalId, opts);
        touch(terminalId);
        if (wasDormant) this.deps.log('thread.process_started', { thread: terminalId, harness, spawnMs: this.now() - (resumeAsked.get(terminalId) ?? this.now()) });
        return pid;
      };
      this.undo.push(() => {
        manager.spawn = original;
        manager.off('busy', touch); manager.off('idle', touch); manager.off('event', onEvent);
        manager.off('permission', touch); manager.off('exit', onExit);
      });
    }
    return () => { for (const u of this.undo.splice(0)) u(); };
  }

  /** The first frame of a resumed process: the process is ready. Logs the time since the resume was asked. */
  private noteFirstFrame(id: string, harness: string, ev: unknown): void {
    const asked = resumeAsked.get(id);
    if (asked === undefined) return;
    const e = ev as { type?: unknown } | null;
    if (e?.type === 'user') return; // the daemon's own echo of the message, not the CLI
    resumeAsked.delete(id);
    this.deps.log('thread.process_resumed', { thread: id, harness, startMs: this.now() - asked });
  }

  /** Every thread with a live per-thread process. */
  liveThreads(): LiveThread[] {
    const out: LiveThread[] = [];
    for (const row of this.allRows()) {
      const manager = this.deps.managers.get(row.type);
      if (!manager || SHARED_PROCESS_HARNESSES.has(row.type)) continue;
      if (manager.isAlive(row.id)) out.push({ id: row.id, harness: row.type, manager });
    }
    return out;
  }

  private allRows(): Array<{ id: string; type: string }> {
    return this.deps.db.prepare('SELECT id, type FROM terminals WHERE archived_at IS NULL').all() as Array<{ id: string; type: string }>;
  }

  /** Why a thread must keep its process, or null when it is idle. */
  busyReason(id: string, manager: IStructuredManager): string | null {
    const row = terminalsDb.getById(this.deps.db, id);
    if (!row) return null;
    if (BUSY_STATUSES.has(row.status)) return `status:${row.status}`;
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(row.config || '{}'); } catch { /* an unreadable config is an empty one */ }
    if (config.runner || config.roleRun) return 'role-run';
    try {
      if (manager.getPending(id)) return 'pending';
      if (manager.hasWaitingPermission?.(id)) return 'pending';
      if ((manager.getBlocked?.(id) ?? []).length > 0) return 'blocked';
      if ((manager.listSubagents?.(id) ?? []).some((s) => RUNNING_SUBAGENT.has(s.state))) return 'subagent';
    } catch {
      return 'unknown'; // a manager that cannot answer: keep the process
    }
    return null;
  }

  private lastUseOf(t: LiveThread): number {
    const seen = this.lastUse.get(t.id);
    const frame = t.manager.lastFrameAt?.(t.id);
    const at = Math.max(seen ?? 0, frame ?? 0);
    if (at > 0) return at;
    // Never seen (spawned before the reaper was attached): its clock starts now.
    const now = this.now();
    this.lastUse.set(t.id, now);
    return now;
  }

  /** Stop one idle process; the thread becomes dormant. */
  private stopDormant(t: LiveThread, reason: 'idle' | 'lru', idleMs: number): void {
    dormantStops.add(t.id);
    try { this.configs.patch(t.id, { [DORMANT_KEY]: new Date(this.now()).toISOString() }); } catch { /* the in-memory mark still holds */ }
    try {
      this.deps.stop(t.id);
    } catch (err) {
      dormantStops.delete(t.id);
      try { this.configs.patch(t.id, { [DORMANT_KEY]: null }); } catch { /* best effort */ }
      this.deps.log('thread.process_stop_failed', { thread: t.id, reason, error: (err as Error)?.message ?? String(err) }, 'warn');
      return;
    }
    this.lastUse.delete(t.id);
    this.deps.log('thread.process_stopped', { thread: t.id, harness: t.harness, reason, idleMinutes: Math.round(idleMs / 6_000) / 10 });
  }

  /** The thread starts again: it is no longer dormant. True when it was. */
  private leaveDormant(id: string): boolean {
    const inMemory = dormantStops.delete(id);
    let persisted = false;
    try {
      this.configs.patch(id, (current) => {
        if (typeof current[DORMANT_KEY] !== 'string') return null;
        persisted = true;
        return { [DORMANT_KEY]: null };
      });
    } catch { /* best effort */ }
    return inMemory || persisted;
  }

  /** Before a start: when the cap is reached, stop the least recently used idle process (never a busy one). */
  makeRoom(startingId: string): void {
    const cap = this.deps.settings.maxLive;
    if (!cap) return;
    const live = this.liveThreads().filter((t) => t.id !== startingId);
    let over = live.length + 1 - cap;
    if (over <= 0) return;
    const now = this.now();
    const idle = live
      .filter((t) => this.busyReason(t.id, t.manager) === null)
      .map((t) => ({ t, at: this.lastUseOf(t) }))
      .sort((a, b) => a.at - b.at);
    for (const { t, at } of idle) {
      if (over <= 0) break;
      this.stopDormant(t, 'lru', now - at);
      over--;
    }
    if (over > 0) this.deps.log('live_cap_exceeded', { thread: startingId, live: live.length + 1, cap }, 'warn');
  }

  /** The periodic pass: stop each idle process past the idle time, and log the live count. */
  tick(): void {
    const now = this.now();
    const idleMs = this.deps.settings.idleMs;
    let live = this.liveThreads();
    if (idleMs > 0) {
      for (const t of live) {
        const at = this.lastUseOf(t);
        if (now - at < idleMs) continue;
        if (this.busyReason(t.id, t.manager) !== null) continue;
        this.stopDormant(t, 'idle', now - at);
      }
      live = this.liveThreads();
    }
    if (live.length !== this.lastCount || now - this.lastCountAt >= COUNT_LOG_EVERY_MS) {
      this.lastCount = live.length;
      this.lastCountAt = now;
      const pids = live.map((t) => terminalsDb.getById(this.deps.db, t.id)?.pid).filter((p): p is number => typeof p === 'number' && p > 0);
      const rss = (this.deps.rssKb ?? readRssKb)(pids);
      this.deps.log('host.live_processes', { count: live.length, rssMb: rss === null ? null : Math.round(rss / 1024), cap: this.deps.settings.maxLive || null, idleMinutes: idleMs ? idleMs / 60_000 : null });
    }
  }
}

/**
 * Resident memory of these processes in KB, from /proc (a hosted box is Linux). Null elsewhere: reading it
 * would need a new child process (`ps`), and the daemon's spawn sites are a fixed list (tests/privsep/spawn-sites.test.ts).
 */
export function readRssKb(pids: number[]): number | null {
  if (process.platform !== 'linux') return null;
  let total = 0;
  for (const pid of pids) {
    try {
      const m = /VmRSS:\s+(\d+)\s*kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
      if (m) total += Number(m[1]);
    } catch { /* the process ended */ }
  }
  return total;
}

/** The reaper of this host, or null when neither variable is set (every local install). */
export function createProcessReaper(deps: Omit<ProcessReaperDeps, 'settings'> & { settings?: ReaperSettings | null }): ProcessReaper | null {
  const settings = deps.settings === undefined ? reaperSettings() : deps.settings;
  if (!settings) return null;
  return new ProcessReaper({ ...deps, settings });
}

/** Test seam: forget the module state. */
export function resetDormantStateForTest(): void { dormantStops.clear(); resumeAsked.clear(); }
