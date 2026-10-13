/**
 * Chat works across all projects, so every thread tool names its project. A project is
 * found by its sessions.id, or by its name (case and outer spaces ignored). An unknown
 * or ambiguous name is an error that tells the model what to pass instead.
 */
import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';

export interface ProjectRef { id: string; name: string; folder: string }
export type ProjectLookup = { ok: true; project: ProjectRef } | { ok: false; error: string };

const MAX_LISTED = 30;

export function resolveProject(sessions: readonly { id: string; name: string | null; working_dir: string }[], ref: unknown): ProjectLookup {
  const want = typeof ref === 'string' ? ref.trim() : '';
  if (!want) return { ok: false, error: 'project is required: a project name or id from the status block' };
  const toRef = (s: { id: string; name: string | null; working_dir: string }): ProjectRef => ({ id: s.id, name: s.name ?? '', folder: s.working_dir });
  const byId = sessions.find((s) => s.id === want);
  if (byId) return { ok: true, project: toRef(byId) };
  const named = sessions.filter((s) => (s.name ?? '').trim().toLowerCase() === want.toLowerCase());
  if (named.length === 1) return { ok: true, project: toRef(named[0]) };
  if (named.length > 1) {
    const list = named.map((s) => `${s.name} (id ${s.id}, folder ${s.working_dir})`).join('; ');
    return { ok: false, error: `"${want}" names ${named.length} projects: ${list}. Pass the id.` };
  }
  const known = sessions.map((s) => s.name ?? s.id);
  const more = known.length > MAX_LISTED ? `, and ${known.length - MAX_LISTED} more` : '';
  return { ok: false, error: `unknown project "${want}". Known projects: ${known.slice(0, MAX_LISTED).join(', ')}${more}` };
}

/** The project's live Control Plane terminal (config.role 'coordinator'), or null. */
export function overseerOf(db: Database.Database, sessionId: string): string | null {
  for (const t of terminalsDb.listBySession(db, sessionId)) {
    if (t.archived_at) continue;
    let cfg: Record<string, unknown> = {};
    try { cfg = JSON.parse(t.config || '{}'); } catch { /* not a coordinator */ }
    if (cfg.role === 'coordinator') return t.id;
  }
  return null;
}
