import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';

/** One file of a preview, as stored: `path` is absolute and already checked against the project root. */
export interface PreviewFile { path: string; name: string; mime: string; size: number }

export interface PreviewRow {
  id: string;
  session_id: string;
  session_name: string;
  terminal_id: string | null;
  terminal_label: string | null;
  title: string;
  note: string | null;
  text: string | null;
  files: string;
  created_at: string;
  seen_at: string | null;
}

/** The wire shape (routes and events). */
export interface Preview {
  id: string;
  sessionId: string;
  sessionName: string;
  terminalId: string | null;
  terminalLabel: string | null;
  title: string;
  note: string | null;
  text: string | null;
  files: PreviewFile[];
  createdAt: string;
  seenAt: string | null;
}

export function toPreview(r: PreviewRow): Preview {
  let files: PreviewFile[] = [];
  try { const v = JSON.parse(r.files); if (Array.isArray(v)) files = v; } catch { /* a corrupt row shows no files */ }
  return {
    id: r.id, sessionId: r.session_id, sessionName: r.session_name, terminalId: r.terminal_id, terminalLabel: r.terminal_label,
    title: r.title, note: r.note, text: r.text, files, createdAt: r.created_at, seenAt: r.seen_at,
  };
}

export interface CreateInput {
  sessionId: string; sessionName: string; terminalId?: string | null; terminalLabel?: string | null;
  title: string; note?: string | null; text?: string | null; files: PreviewFile[];
}

export function create(db: Database.Database, input: CreateInput): Preview {
  const id = uuid();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO previews (id, session_id, session_name, terminal_id, terminal_label, title, note, text, files, created_at, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(id, input.sessionId, input.sessionName, input.terminalId ?? null, input.terminalLabel ?? null, input.title, input.note ?? null, input.text ?? null, JSON.stringify(input.files), now);
  return getById(db, id)!;
}

export function getById(db: Database.Database, id: string): Preview | null {
  const r = db.prepare('SELECT * FROM previews WHERE id = ?').get(id) as PreviewRow | undefined;
  return r ? toPreview(r) : null;
}

/** Newest first; `sessionId` narrows to one project. */
export function list(db: Database.Database, opts: { sessionId?: string; limit?: number } = {}): Preview[] {
  const limit = Math.max(1, Math.min(1000, opts.limit ?? 200));
  const rows = (opts.sessionId
    ? db.prepare('SELECT * FROM previews WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(opts.sessionId, limit)
    : db.prepare('SELECT * FROM previews ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit)) as PreviewRow[];
  return rows.map(toPreview);
}

/** Mark seen; returns the row, or null when there is none. Idempotent: an already-seen row keeps its time. */
export function markSeen(db: Database.Database, id: string): Preview | null {
  db.prepare('UPDATE previews SET seen_at = COALESCE(seen_at, ?) WHERE id = ?').run(new Date().toISOString(), id);
  return getById(db, id);
}

export function remove(db: Database.Database, id: string): boolean {
  return db.prepare('DELETE FROM previews WHERE id = ?').run(id).changes > 0;
}

export function unseenCount(db: Database.Database, sessionId?: string): number {
  const r = (sessionId
    ? db.prepare('SELECT COUNT(*) AS n FROM previews WHERE seen_at IS NULL AND session_id = ?').get(sessionId)
    : db.prepare('SELECT COUNT(*) AS n FROM previews WHERE seen_at IS NULL').get()) as { n: number };
  return r.n;
}
