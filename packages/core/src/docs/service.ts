import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import type { EndlessStore } from '../endless/store.js';
import { resolveDoc, type DocResult, type DocResolver } from './resolve.js';
import { listDocs, DOCS_CACHE_MS, type DocRow, type DocLister } from './list.js';

/** At most this many doc lookups run at once across the daemon; the rest wait their turn. */
export const DOC_CONCURRENCY = 4;
/** A doc lookup (the wait for a turn included) that takes longer than this fails with DocTimeoutError. */
export const DOC_DEADLINE_MS = 3000;

/** A doc lookup passed DOC_DEADLINE_MS; its late result is dropped. */
export class DocTimeoutError extends Error {
  constructor() { super('the doc lookup took too long'); this.name = 'DocTimeoutError'; }
}

export interface DocLookupOptions { resolver?: DocResolver; maxConcurrent?: number; deadlineMs?: number }

/** At most this many project ids per counts request. */
const COUNTS_MAX_PROJECTS = 50;
/** At most this many projects with no value are computed at once in one counts request. */
const COUNTS_COLD_CONCURRENCY = 3;

type DocList = { rows: DocRow[]; total: number };

/** The doc route's view of the projects: a registered project folder, and a doc read under it only. */
export class DocsService {
  private readonly cache = new Map<string, { at: number; value: DocList }>();
  /** The compute that runs for a project (cold or background); at most one per project. */
  private readonly inflight = new Map<string, Promise<DocList>>();
  private readonly resolver: DocResolver;
  private readonly maxConcurrent: number;
  private readonly deadlineMs: number;
  /** Doc lookups that run now, and the ones that wait for a turn. */
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly db: Database.Database, private readonly store?: EndlessStore, private readonly now: () => number = Date.now, private readonly lister: DocLister = listDocs, lookup: DocLookupOptions = {}) {
    this.resolver = lookup.resolver ?? resolveDoc;
    this.maxConcurrent = lookup.maxConcurrent ?? DOC_CONCURRENCY;
    this.deadlineMs = lookup.deadlineMs ?? DOC_DEADLINE_MS;
  }
  project(id: string): { id: string; folder: string } | null {
    const s = sessionsDb.getById(this.db, id);
    return s ? { id: s.id, folder: s.working_dir } : null;
  }
  /**
   * Null for an unknown project. At most `maxConcurrent` lookups run at once; one that has not
   * finished `deadlineMs` after the call (the wait for a turn included) rejects with
   * DocTimeoutError, and a lookup still waiting for a turn then never starts. A lookup that already
   * runs keeps its turn until it ends (each git call has its own 5 s timeout), so the bound holds.
   */
  async doc(projectId: string, docPath: string, branch: string | null, worktree: string | null = null): Promise<DocResult | null> {
    const p = this.project(projectId);
    if (!p) return null;
    let late = false;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { late = true; reject(new DocTimeoutError()); }, this.deadlineMs); });
    const job = this.inTurn(() => (late ? Promise.resolve(null) : this.resolver(p, docPath, { branch, worktree })));
    job.catch(() => { /* a late failure is dropped */ });
    try { return await Promise.race([job, deadline]); } finally { clearTimeout(timer); }
  }
  /** Runs `fn` when a turn is free (at most `maxConcurrent` at once), and frees the turn after it. */
  private async inTurn<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running < this.maxConcurrent) this.running++;
    else await new Promise<void>((res) => this.waiting.push(res)); // the turn is handed over as it is
    try { return await fn(); } finally {
      const next = this.waiting.shift();
      if (next) next(); else this.running--;
    }
  }
  /** The in-progress docs of a project, cached DOCS_CACHE_MS; null for an unknown project. */
  async list(projectId: string): Promise<DocList | null> {
    const p = this.project(projectId);
    if (!p) return null;
    const hit = this.cache.get(projectId);
    if (hit && this.now() - hit.at < DOCS_CACHE_MS) return hit.value;
    // A compute already runs for it: wait for that one, not a second. If it fails, try once here.
    const job = this.inflight.get(projectId);
    if (job) { const v = await job.catch(() => null); if (v) return v; }
    return this.compute(p);
  }
  /**
   * The in-progress doc total per known project id (unknown ids are left out). Stale while
   * revalidate: a cached value is answered at once, even when older than DOCS_CACHE_MS, and a
   * stale one starts one background refresh. A project with no value is computed before the
   * answer, at most COUNTS_COLD_CONCURRENCY at a time.
   */
  async counts(ids: string[]): Promise<Record<string, number>> {
    const totals = new Map<string, number>();
    const order: string[] = [];
    const cold: { id: string; folder: string }[] = [];
    for (const id of ids.slice(0, COUNTS_MAX_PROJECTS)) {
      const p = this.project(id);
      if (!p) continue;
      order.push(id);
      const hit = this.cache.get(id);
      if (!hit) { cold.push(p); continue; }
      totals.set(id, hit.value.total);
      if (this.now() - hit.at >= DOCS_CACHE_MS && !this.inflight.has(id)) {
        this.compute(p).catch(() => { /* keep the old value; the next call tries again */ });
      }
    }
    let next = 0;
    const worker = async () => {
      while (next < cold.length) { const p = cold[next++]; totals.set(p.id, (await this.compute(p)).total); }
    };
    await Promise.all(Array.from({ length: Math.min(COUNTS_COLD_CONCURRENCY, cold.length) }, worker));
    const out: Record<string, number> = {};
    for (const id of order) { const v = totals.get(id); if (v !== undefined) out[id] = v; }
    return out;
  }
  /** Computes the project's list, or joins the compute that already runs for it. */
  private compute(p: { id: string; folder: string }): Promise<DocList> {
    const running = this.inflight.get(p.id);
    if (running) return running;
    const job = (async () => {
      const value = await this.lister(p, (c) => this.writerOf(p.id, c));
      this.cache.set(p.id, { at: this.now(), value });
      return value;
    })().finally(() => this.inflight.delete(p.id));
    this.inflight.set(p.id, job);
    return job;
  }
  /** The thread that wrote a doc: a live thread working in its worktree, else the last work report that names it. */
  private writerOf(projectId: string, c: { path: string; worktreeReal: string | null }): { id: string; label: string } | null {
    if (c.worktreeReal) {
      const rows = this.db.prepare('SELECT id, label, working_dir FROM terminals WHERE session_id = ? AND archived_at IS NULL AND working_dir IS NOT NULL ORDER BY COALESCE(last_activity_at, created_at) DESC').all(projectId) as { id: string; label: string; working_dir: string }[];
      for (const r of rows) {
        let real: string; try { real = fs.realpathSync.native(r.working_dir); } catch { continue; } // a folder that is gone is no writer
        if (real === c.worktreeReal || real.startsWith(c.worktreeReal + path.sep)) return { id: r.id, label: r.label };
      }
    }
    const m = this.store?.lastWorkMentioning(projectId, c.path);
    if (m?.ref) { const t = terminalsDb.getById(this.db, m.ref); if (t) return { id: t.id, label: t.label }; }
    return null;
  }
}
