import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import type { EndlessStore } from '../endless/store.js';
import { resolveDoc, type DocResult } from './resolve.js';
import { listDocs, DOCS_CACHE_MS, type DocRow } from './list.js';

/** At most this many project ids per counts request. */
const COUNTS_MAX_PROJECTS = 50;

/** The doc route's view of the projects: a registered project folder, and a doc read under it only. */
export class DocsService {
  private readonly cache = new Map<string, { at: number; value: { rows: DocRow[]; total: number } }>();
  constructor(private readonly db: Database.Database, private readonly store?: EndlessStore, private readonly now: () => number = Date.now) {}
  project(id: string): { id: string; folder: string } | null {
    const s = sessionsDb.getById(this.db, id);
    return s ? { id: s.id, folder: s.working_dir } : null;
  }
  /** Null for an unknown project. */
  doc(projectId: string, docPath: string, branch: string | null): DocResult | null {
    const p = this.project(projectId);
    return p ? resolveDoc(p, docPath, { branch }) : null;
  }
  /** The in-progress docs of a project, cached DOCS_CACHE_MS; null for an unknown project. */
  list(projectId: string): { rows: DocRow[]; total: number } | null {
    const p = this.project(projectId);
    if (!p) return null;
    const hit = this.cache.get(projectId);
    if (hit && this.now() - hit.at < DOCS_CACHE_MS) return hit.value;
    const value = listDocs(p, (c) => this.writerOf(projectId, c));
    this.cache.set(projectId, { at: this.now(), value });
    return value;
  }
  /** The in-progress doc total per known project id (unknown ids are left out). */
  counts(ids: string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const id of ids.slice(0, COUNTS_MAX_PROJECTS)) { const l = this.list(id); if (l) out[id] = l.total; }
    return out;
  }
  /** The thread that wrote a doc: a live thread working in its worktree, else the last work report that names it. */
  private writerOf(projectId: string, c: { path: string; worktreeReal: string | null }): { id: string; label: string } | null {
    if (c.worktreeReal) {
      const rows = this.db.prepare('SELECT id, label, working_dir FROM terminals WHERE session_id = ? AND archived_at IS NULL AND working_dir IS NOT NULL ORDER BY COALESCE(last_activity_at, created_at) DESC').all(projectId) as { id: string; label: string; working_dir: string }[];
      for (const r of rows) {
        let real = r.working_dir; try { real = fs.realpathSync.native(r.working_dir); } catch { /* keep */ }
        if (real === c.worktreeReal || real.startsWith(c.worktreeReal + path.sep)) return { id: r.id, label: r.label };
      }
    }
    const m = this.store?.lastWorkMentioning(projectId, c.path);
    if (m?.ref) { const t = terminalsDb.getById(this.db, m.ref); if (t) return { id: t.id, label: t.label }; }
    return null;
  }
}
