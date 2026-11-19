import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * Memory storage (docs/superpowers/specs/2026-11-17-memory-design.md, section 4.2). The only module
 * that touches the memory_* tables. The daemon is the one writer: threads reach it through tools
 * and routes, never through files.
 *
 * Every change to a page adds a version row in the same transaction. Nothing is deleted in place:
 * a deleted page keeps its row with status 'deleted', and a deleted note keeps its row with status
 * 'deleted' (both leave the search index). Limits are small on purpose (section 4.2).
 */

/** 'you' (the person, every thread) or 'project:<session id>' (the threads of one project). */
export type MemoryScope = string;
export type PageStatus = 'active' | 'retired' | 'deleted';
export type PageActor = 'user' | 'dream' | 'import';
export type PageOp = 'create' | 'edit' | 'pin' | 'unpin' | 'delete' | 'restore';
export type NoteOrigin = 'thread' | 'user' | 'analyzer' | 'import';
export type NoteStatus = 'new' | 'used' | 'deleted';

export const MAX_PAGE_BYTES = 16 * 1024;
export const MAX_ACTIVE_PAGES = 200;
export const MAX_NOTE_CHARS = 2000;
export const MAX_DESCRIPTION_CHARS = 200;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SCOPE_RE = /^(you|project:[A-Za-z0-9_-]{1,64})$/;

/** A memory request that cannot be done; `status` is the HTTP status a route answers with. */
export class MemoryError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 = 400) { super(message); }
}

export const YOU: MemoryScope = 'you';
export const projectScope = (sessionId: string): MemoryScope => `project:${sessionId}`;
export const isScope = (v: unknown): v is MemoryScope => typeof v === 'string' && SCOPE_RE.test(v);
/** The session id of a project scope, else null. */
export const scopeProject = (scope: MemoryScope): string | null => scope.startsWith('project:') ? scope.slice(8) : null;
export const isSlug = (v: unknown): v is string => typeof v === 'string' && SLUG_RE.test(v);

export interface MemoryPage {
  id: number; scope: MemoryScope; slug: string; description: string; body: string; pinned: boolean; status: PageStatus;
  createdAt: string; updatedAt: string; updatedBy: PageActor; verifiedAt: string | null; readCount: number; lastReadAt: string | null; sha: string;
}
export type MemoryPageSummary = Omit<MemoryPage, 'body'> & { bytes: number };
export interface MemoryVersion { id: number; pageId: number; body: string; description: string; status: PageStatus; op: PageOp; actor: PageActor; dreamId: string | null; at: string }
export interface MemoryNote {
  id: number; scope: MemoryScope; text: string; aboutSlug: string | null; origin: NoteOrigin; terminalId: string | null;
  seqFrom: number | null; seqTo: number | null; harness: string | null; askedByUser: boolean; externalContext: boolean;
  sourceRef: string | null; createdAt: string; dreamId: string | null; status: NoteStatus;
}
export interface NoteInput {
  scope: MemoryScope; text: string; aboutSlug?: string | null; origin: NoteOrigin; terminalId?: string | null;
  seqFrom?: number | null; seqTo?: number | null; harness?: string | null; askedByUser?: boolean; externalContext?: boolean;
  sourceRef?: string | null; createdAt?: string;
}
/** `source`: 'dispatch' for pages and notes, the provider id for a mirrored entry (kind 'entry', `slug` = its title). */
export interface MemorySearchHit { kind: 'page' | 'note' | 'entry'; id: number; scope: MemoryScope; slug: string | null; snippet: string; source: string }
export interface ScopeCounts { scope: MemoryScope; pages: number; newNotes: number }

/** Snippet highlight markers: control characters that never occur in typed text (as in Chat search). */
export const SNIPPET_OPEN = '\u0002';
export const SNIPPET_CLOSE = '\u0003';

interface PageRow {
  id: number; scope: string; slug: string; description: string; body: string; pinned: number; status: PageStatus;
  created_at: string; updated_at: string; updated_by: PageActor; verified_at: string | null; read_count: number; last_read_at: string | null; sha: string;
}
interface NoteRow {
  id: number; scope: string; text: string; about_slug: string | null; origin: NoteOrigin; terminal_id: string | null;
  seq_from: number | null; seq_to: number | null; harness: string | null; asked_by_user: number; external_context: number;
  source_ref: string | null; created_at: string; dream_id: string | null; status: NoteStatus;
}
interface VersionRow { id: number; page_id: number; body: string; description: string; status: PageStatus; op: PageOp; actor: PageActor; dream_id: string | null; at: string }

const toPage = (r: PageRow): MemoryPage => ({
  id: r.id, scope: r.scope, slug: r.slug, description: r.description, body: r.body, pinned: r.pinned === 1, status: r.status,
  createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by, verifiedAt: r.verified_at, readCount: r.read_count,
  lastReadAt: r.last_read_at, sha: r.sha,
});
const toNote = (r: NoteRow): MemoryNote => ({
  id: r.id, scope: r.scope, text: r.text, aboutSlug: r.about_slug, origin: r.origin, terminalId: r.terminal_id,
  seqFrom: r.seq_from, seqTo: r.seq_to, harness: r.harness, askedByUser: r.asked_by_user === 1, externalContext: r.external_context === 1,
  sourceRef: r.source_ref, createdAt: r.created_at, dreamId: r.dream_id, status: r.status,
});
const toVersion = (r: VersionRow): MemoryVersion => ({
  id: r.id, pageId: r.page_id, body: r.body, description: r.description, status: r.status, op: r.op, actor: r.actor, dreamId: r.dream_id, at: r.at,
});

/** The content hash a person's edit must name, so an edit made on an old copy is refused. */
export const pageSha = (description: string, body: string): string =>
  createHash('sha256').update(description).update('\u0000').update(body).digest('hex').slice(0, 16);

const now = () => new Date().toISOString();

function checkScope(scope: unknown): asserts scope is MemoryScope {
  if (!isScope(scope)) throw new MemoryError('bad scope');
}
function cleanDescription(v: unknown): string {
  if (v == null) return '';
  if (typeof v !== 'string') throw new MemoryError('bad description');
  const t = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (t.length > MAX_DESCRIPTION_CHARS) throw new MemoryError(`description longer than ${MAX_DESCRIPTION_CHARS} characters`);
  return t;
}
function cleanBody(v: unknown): string {
  if (v == null) return '';
  if (typeof v !== 'string') throw new MemoryError('bad body');
  if (Buffer.byteLength(v, 'utf8') > MAX_PAGE_BYTES) throw new MemoryError(`page larger than ${MAX_PAGE_BYTES} bytes`);
  return v;
}

function addVersion(db: Database.Database, p: MemoryPage, op: PageOp, actor: PageActor, dreamId: string | null = null): void {
  db.prepare('INSERT INTO memory_versions (page_id, body, description, status, op, actor, dream_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(p.id, p.body, p.description, p.status, op, actor, dreamId, p.updatedAt);
}

function activeCount(db: Database.Database, scope: MemoryScope): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM memory_pages WHERE scope = ? AND status = 'active'").get(scope) as { n: number }).n;
}

// ---- pages ----

export function getPage(db: Database.Database, id: number): MemoryPage | null {
  const r = db.prepare('SELECT * FROM memory_pages WHERE id = ?').get(id) as PageRow | undefined;
  return r ? toPage(r) : null;
}

export function getPageBySlug(db: Database.Database, scope: MemoryScope, slug: string): MemoryPage | null {
  const r = db.prepare('SELECT * FROM memory_pages WHERE scope = ? AND slug = ?').get(scope, slug) as PageRow | undefined;
  return r ? toPage(r) : null;
}

/** The pages of a scope that are not deleted, pinned first, then by slug. */
export function listPages(db: Database.Database, scope: MemoryScope, opts: { includeDeleted?: boolean } = {}): MemoryPageSummary[] {
  const rows = db.prepare(`SELECT *, length(CAST(body AS BLOB)) AS bytes FROM memory_pages WHERE scope = ? ${opts.includeDeleted ? '' : "AND status != 'deleted'"}
    ORDER BY pinned DESC, slug ASC`).all(scope) as (PageRow & { bytes: number })[];
  return rows.map((r) => { const { body: _body, ...rest } = toPage(r); return { ...rest, bytes: r.bytes }; });
}

/**
 * A new page. A slug that belongs to a deleted page brings that page back with the new text (one
 * row per slug, so its history stays together). Throws on a bad slug, a slug in use, or the
 * page-count limit.
 */
export function createPage(db: Database.Database, input: { scope: MemoryScope; slug: string; description?: string; body?: string; pinned?: boolean }, actor: PageActor): MemoryPage {
  checkScope(input.scope);
  if (!isSlug(input.slug)) throw new MemoryError('bad slug: use a-z, 0-9 and -, at most 64 characters');
  const description = cleanDescription(input.description);
  const body = cleanBody(input.body);
  return db.transaction(() => {
    const old = getPageBySlug(db, input.scope, input.slug);
    if (old && old.status !== 'deleted') throw new MemoryError('a page with this slug exists', 409);
    if (activeCount(db, input.scope) >= MAX_ACTIVE_PAGES) throw new MemoryError(`a scope holds at most ${MAX_ACTIVE_PAGES} pages`, 409);
    const at = now();
    const sha = pageSha(description, body);
    let id: number;
    if (old) {
      db.prepare("UPDATE memory_pages SET description = ?, body = ?, pinned = ?, status = 'active', updated_at = ?, updated_by = ?, sha = ? WHERE id = ?")
        .run(description, body, input.pinned ? 1 : 0, at, actor, sha, old.id);
      id = old.id;
    } else {
      id = Number(db.prepare(`INSERT INTO memory_pages (scope, slug, description, body, pinned, status, created_at, updated_at, updated_by, sha)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`).run(input.scope, input.slug, description, body, input.pinned ? 1 : 0, at, at, actor, sha).lastInsertRowid);
    }
    const page = getPage(db, id)!;
    addVersion(db, page, 'create', actor);
    return page;
  })();
}

/**
 * Edit the text of a page. `expectedSha` is the sha the editor started from: a page that changed
 * since is refused (409), so an edit never silently drops a newer change.
 */
export function updatePage(db: Database.Database, id: number, patch: { description?: string; body?: string; expectedSha?: string }, actor: PageActor): MemoryPage {
  return db.transaction(() => {
    const old = getPage(db, id);
    if (!old || old.status === 'deleted') throw new MemoryError('no such page', 404);
    if (patch.expectedSha !== undefined && patch.expectedSha !== old.sha) throw new MemoryError('the page changed since you opened it', 409);
    const description = patch.description === undefined ? old.description : cleanDescription(patch.description);
    const body = patch.body === undefined ? old.body : cleanBody(patch.body);
    if (description === old.description && body === old.body) return old;
    db.prepare('UPDATE memory_pages SET description = ?, body = ?, updated_at = ?, updated_by = ?, sha = ? WHERE id = ?')
      .run(description, body, now(), actor, pageSha(description, body), id);
    const page = getPage(db, id)!;
    addVersion(db, page, 'edit', actor);
    return page;
  })();
}

export function setPinned(db: Database.Database, id: number, pinned: boolean, actor: PageActor): MemoryPage {
  return db.transaction(() => {
    const old = getPage(db, id);
    if (!old || old.status === 'deleted') throw new MemoryError('no such page', 404);
    if (old.pinned === pinned) return old;
    db.prepare('UPDATE memory_pages SET pinned = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(pinned ? 1 : 0, now(), actor, id);
    const page = getPage(db, id)!;
    addVersion(db, page, pinned ? 'pin' : 'unpin', actor);
    return page;
  })();
}

/** Mark a page deleted. The row and its versions stay; the page leaves search and the block. */
export function deletePage(db: Database.Database, id: number, actor: PageActor): MemoryPage {
  return db.transaction(() => {
    const old = getPage(db, id);
    if (!old || old.status === 'deleted') throw new MemoryError('no such page', 404);
    db.prepare("UPDATE memory_pages SET status = 'deleted', pinned = 0, updated_at = ?, updated_by = ? WHERE id = ?").run(now(), actor, id);
    const page = getPage(db, id)!;
    addVersion(db, page, 'delete', actor);
    return page;
  })();
}

/** Put the text of one version back as the newest version (also brings a deleted page back). */
export function restoreVersion(db: Database.Database, id: number, versionId: number, actor: PageActor): MemoryPage {
  return db.transaction(() => {
    const old = getPage(db, id);
    if (!old) throw new MemoryError('no such page', 404);
    const v = db.prepare('SELECT * FROM memory_versions WHERE id = ? AND page_id = ?').get(versionId, id) as VersionRow | undefined;
    if (!v) throw new MemoryError('no such version', 404);
    const status: PageStatus = v.status === 'deleted' ? 'active' : v.status;
    if (old.status === 'deleted' && status === 'active' && activeCount(db, old.scope) >= MAX_ACTIVE_PAGES) {
      throw new MemoryError(`a scope holds at most ${MAX_ACTIVE_PAGES} pages`, 409);
    }
    db.prepare('UPDATE memory_pages SET description = ?, body = ?, status = ?, updated_at = ?, updated_by = ?, sha = ? WHERE id = ?')
      .run(v.description, v.body, status, now(), actor, pageSha(v.description, v.body), id);
    const page = getPage(db, id)!;
    addVersion(db, page, 'restore', actor);
    return page;
  })();
}

export function listVersions(db: Database.Database, pageId: number): MemoryVersion[] {
  return (db.prepare('SELECT * FROM memory_versions WHERE page_id = ? ORDER BY id DESC').all(pageId) as VersionRow[]).map(toVersion);
}

/** Count a read by a thread (section 3.2 of phase 3 uses it to let unused pages fade). */
export function markRead(db: Database.Database, id: number): void {
  db.prepare('UPDATE memory_pages SET read_count = read_count + 1, last_read_at = ? WHERE id = ?').run(now(), id);
}

// ---- notes ----

/**
 * Save a note. A note with a `sourceRef` that the scope already holds is not saved again (an
 * import runs at every start); the existing note is returned.
 */
export function addNote(db: Database.Database, input: NoteInput): MemoryNote {
  checkScope(input.scope);
  if (typeof input.text !== 'string') throw new MemoryError('bad text');
  const text = input.text.replace(/\r\n?/g, '\n').trim();
  if (!text) throw new MemoryError('empty note');
  if (text.length > MAX_NOTE_CHARS) throw new MemoryError(`a note is at most ${MAX_NOTE_CHARS} characters`);
  if (input.aboutSlug != null && !isSlug(input.aboutSlug)) throw new MemoryError('bad about: name a page slug');
  if (input.sourceRef) {
    const r = db.prepare('SELECT * FROM memory_notes WHERE scope = ? AND source_ref = ?').get(input.scope, input.sourceRef) as NoteRow | undefined;
    if (r) return toNote(r);
  }
  const id = Number(db.prepare(`INSERT INTO memory_notes (scope, text, about_slug, origin, terminal_id, seq_from, seq_to, harness,
      asked_by_user, external_context, source_ref, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`)
    .run(input.scope, text, input.aboutSlug ?? null, input.origin, input.terminalId ?? null, input.seqFrom ?? null, input.seqTo ?? null,
      input.harness ?? null, input.askedByUser ? 1 : 0, input.externalContext ? 1 : 0, input.sourceRef ?? null, input.createdAt ?? now()).lastInsertRowid);
  return getNote(db, id)!;
}

export function getNote(db: Database.Database, id: number): MemoryNote | null {
  const r = db.prepare('SELECT * FROM memory_notes WHERE id = ?').get(id) as NoteRow | undefined;
  return r ? toNote(r) : null;
}

/** Notes of a scope, newest first. `status` 'live' = not deleted (the default). */
export function listNotes(db: Database.Database, scope: MemoryScope, opts: { status?: NoteStatus | 'live'; aboutSlug?: string; limit?: number } = {}): MemoryNote[] {
  const status = opts.status ?? 'live';
  const where = status === 'live' ? "status != 'deleted'" : 'status = @status';
  const rows = db.prepare(`SELECT * FROM memory_notes WHERE scope = @scope AND ${where} ${opts.aboutSlug ? 'AND about_slug = @about' : ''}
    ORDER BY id DESC LIMIT @limit`).all({ scope, status, about: opts.aboutSlug ?? null, limit: opts.limit ?? 500 }) as NoteRow[];
  return rows.map(toNote);
}

/** Mark a note deleted (it leaves search and the block; the row stays). */
export function deleteNote(db: Database.Database, id: number): boolean {
  return db.prepare("UPDATE memory_notes SET status = 'deleted' WHERE id = ? AND status != 'deleted'").run(id).changes > 0;
}

// ---- scopes and search ----

/** Every scope that holds a page or a live note, with counts. */
export function scopeCounts(db: Database.Database): ScopeCounts[] {
  const rows = db.prepare(`SELECT scope, SUM(pages) AS pages, SUM(notes) AS newNotes FROM (
      SELECT scope, COUNT(*) AS pages, 0 AS notes FROM memory_pages WHERE status = 'active' GROUP BY scope
      UNION ALL SELECT scope, 0, COUNT(*) FROM memory_notes WHERE status = 'new' GROUP BY scope
    ) GROUP BY scope ORDER BY scope`).all() as ScopeCounts[];
  return rows;
}

/** Each typed word becomes a quoted prefix term, so FTS5 syntax in the query is plain text. */
export function ftsQuery(q: string): string | null {
  const terms = q.split(/\s+/).filter(Boolean).slice(0, 16);
  if (!terms.length) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

/** Full-text search over the active pages and live notes of the given scopes, best match first. */
export function search(db: Database.Database, q: string, scopes: MemoryScope[], limit = 20): MemorySearchHit[] {
  const match = ftsQuery(q);
  if (!match || !scopes.length) return [];
  const marks = scopes.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT rowid AS rid, scope, kind, slug, snippet(memory_fts, 1, ?, ?, '…', 16) AS snippet
    FROM memory_fts WHERE memory_fts MATCH ? AND scope IN (${marks}) ORDER BY bm25(memory_fts, 4.0, 1.0) LIMIT ?`)
    .all(SNIPPET_OPEN, SNIPPET_CLOSE, match, ...scopes, Math.max(1, Math.min(limit, 100))) as { rid: number; scope: string; kind: 'page' | 'note' | 'entry'; slug: string; snippet: string }[];
  const providerOf = db.prepare('SELECT provider FROM memory_mirror WHERE id = ?');
  return rows.map((r) => {
    if (r.kind === 'entry') {
      const id = r.rid - MIRROR_ROWID_BASE;
      return { kind: 'entry' as const, id, scope: r.scope, slug: r.slug || null, snippet: r.snippet, source: (providerOf.get(id) as { provider: string } | undefined)?.provider ?? 'unknown' };
    }
    return { kind: r.kind, id: Math.abs(r.rid), scope: r.scope, slug: r.slug || null, snippet: r.snippet, source: 'dispatch' };
  });
}

// ---- threads ----

export function isOffRecord(db: Database.Database, terminalId: string): boolean {
  const r = db.prepare('SELECT off_record FROM memory_cursors WHERE terminal_id = ?').get(terminalId) as { off_record: number } | undefined;
  return r?.off_record === 1;
}

export function setOffRecord(db: Database.Database, terminalId: string, off: boolean): void {
  db.prepare(`INSERT INTO memory_cursors (terminal_id, off_record) VALUES (?, ?)
    ON CONFLICT(terminal_id) DO UPDATE SET off_record = excluded.off_record`).run(terminalId, off ? 1 : 0);
}

// ---- conversation turns (layer 1) ----

export interface TurnCursor { terminalId: string; lastSeq: number; source: string | null; fileOffset: number; offRecord: boolean }
export interface TurnInput { role: 'user' | 'assistant'; text: string; ref?: string | null; at?: string | null }
export interface TurnHit { id: number; terminalId: string; sessionId: string; thread: string; role: string; ref: string | null; at: string | null; snippet: string }

/** The longest turn text that is indexed; the rest of a very long message is not searchable. */
export const MAX_TURN_CHARS = 8000;

export function getCursor(db: Database.Database, terminalId: string): TurnCursor {
  const r = db.prepare('SELECT * FROM memory_cursors WHERE terminal_id = ?').get(terminalId) as
    { terminal_id: string; last_seq: number; source: string | null; file_offset: number; off_record: number } | undefined;
  return { terminalId, lastSeq: r?.last_seq ?? 0, source: r?.source ?? null, fileOffset: r?.file_offset ?? 0, offRecord: r?.off_record === 1 };
}

/** Add the turns read from a thread and move its cursor, in one transaction. */
export function addTurns(db: Database.Database, terminalId: string, turns: TurnInput[], cursor: { lastSeq?: number; source?: string | null; fileOffset?: number }): number {
  return db.transaction(() => {
    const ins = db.prepare('INSERT INTO memory_turns (terminal_id, role, ref, at, text) VALUES (?, ?, ?, ?, ?)');
    let n = 0;
    for (const t of turns) {
      const text = t.text.trim().slice(0, MAX_TURN_CHARS);
      if (!text) continue;
      ins.run(terminalId, t.role, t.ref ?? null, t.at ?? null, text);
      n++;
    }
    const old = getCursor(db, terminalId);
    db.prepare(`INSERT INTO memory_cursors (terminal_id, last_seq, last_at, source, file_offset) VALUES (@id, @seq, @at, @source, @offset)
      ON CONFLICT(terminal_id) DO UPDATE SET last_seq = @seq, last_at = @at, source = @source, file_offset = @offset`)
      .run({ id: terminalId, seq: cursor.lastSeq ?? old.lastSeq, at: new Date().toISOString(), source: cursor.source === undefined ? old.source : cursor.source, offset: cursor.fileOffset ?? old.fileOffset });
    return n;
  })();
}

/**
 * Search the turns of threads that are not off the record. `sessionIds` null: every project
 * (the person); else only threads that are now in those projects.
 */
export function searchTurns(db: Database.Database, q: string, sessionIds: string[] | null, limit = 20): TurnHit[] {
  const match = ftsQuery(q);
  if (!match || (sessionIds && !sessionIds.length)) return [];
  const projects = sessionIds ? `AND t.session_id IN (${sessionIds.map(() => '?').join(', ')})` : '';
  const rows = db.prepare(`SELECT mt.id, mt.terminal_id, t.session_id, t.label, mt.role, mt.ref, mt.at,
      snippet(memory_turns_fts, 0, ?, ?, '…', 16) AS snippet
    FROM memory_turns_fts
    JOIN memory_turns mt ON mt.id = memory_turns_fts.rowid
    JOIN terminals t ON t.id = mt.terminal_id
    LEFT JOIN memory_cursors c ON c.terminal_id = mt.terminal_id
    WHERE memory_turns_fts MATCH ? AND COALESCE(c.off_record, 0) = 0 ${projects}
    ORDER BY rank LIMIT ?`)
    .all(SNIPPET_OPEN, SNIPPET_CLOSE, match, ...(sessionIds ?? []), Math.max(1, Math.min(limit, 100))) as
    { id: number; terminal_id: string; session_id: string; label: string; role: string; ref: string | null; at: string | null; snippet: string }[];
  return rows.map((r) => ({ id: r.id, terminalId: r.terminal_id, sessionId: r.session_id, thread: r.label, role: r.role, ref: r.ref, at: r.at, snippet: r.snippet }));
}

// ---- the provider mirror (spec 4.8) ----

/** memory_fts rowids of mirrored entries start here (pages: +id, notes: -id). */
export const MIRROR_ROWID_BASE = 1099511627776;

export interface MirrorRow {
  id: number; provider: string; scope: MemoryScope; rel: string; path: string | null; sha: string; mtimeMs: number;
  title: string; description: string; text: string; writable: boolean; syncedAt: string;
}
interface MirrorDbRow { id: number; provider: string; scope: string; rel: string; path: string | null; sha: string; mtime: number; title: string; description: string; text: string; writable: number; synced_at: string }
const toMirror = (r: MirrorDbRow): MirrorRow => ({ id: r.id, provider: r.provider, scope: r.scope, rel: r.rel, path: r.path, sha: r.sha, mtimeMs: r.mtime, title: r.title, description: r.description, text: r.text, writable: r.writable === 1, syncedAt: r.synced_at });

export interface MirrorInput { rel: string; path?: string | null; sha: string; mtimeMs: number; title: string; description: string; text: string; writable: boolean }

/**
 * Make the mirror of one provider and scope equal to `entries`: insert new ones, update a changed sha,
 * delete the rows whose file is gone. Returns how many rows changed.
 */
export function syncMirror(db: Database.Database, provider: string, scope: MemoryScope, entries: MirrorInput[]): number {
  return db.transaction(() => {
    const rows = new Map((db.prepare('SELECT * FROM memory_mirror WHERE provider = ? AND scope = ?').all(provider, scope) as MirrorDbRow[]).map((r) => [r.rel, r]));
    const at = now();
    let changed = 0;
    for (const e of entries) {
      const old = rows.get(e.rel);
      rows.delete(e.rel);
      if (old && old.sha === e.sha && old.title === e.title && old.writable === (e.writable ? 1 : 0)) continue;
      db.prepare(`INSERT INTO memory_mirror (provider, scope, rel, path, sha, mtime, title, description, text, writable, synced_at)
        VALUES (@provider, @scope, @rel, @path, @sha, @mtime, @title, @description, @text, @writable, @at)
        ON CONFLICT(provider, scope, rel) DO UPDATE SET path = @path, sha = @sha, mtime = @mtime, title = @title, description = @description,
          text = @text, writable = @writable, synced_at = @at`)
        .run({ provider, scope, rel: e.rel, path: e.path ?? null, sha: e.sha, mtime: Math.round(e.mtimeMs), title: e.title, description: e.description, text: e.text, writable: e.writable ? 1 : 0, at });
      changed++;
    }
    for (const gone of rows.values()) { db.prepare('DELETE FROM memory_mirror WHERE id = ?').run(gone.id); changed++; }
    return changed;
  })();
}

/** Forget a provider's mirror (its "Dispatch reads it" switch went off). */
export function clearMirror(db: Database.Database, provider: string): number {
  return db.prepare('DELETE FROM memory_mirror WHERE provider = ?').run(provider).changes;
}

export function listMirror(db: Database.Database, scopes: MemoryScope[], provider?: string): MirrorRow[] {
  if (!scopes.length) return [];
  const rows = db.prepare(`SELECT * FROM memory_mirror WHERE scope IN (${scopes.map(() => '?').join(', ')}) ${provider ? 'AND provider = ?' : ''}
    ORDER BY provider, title`).all(...scopes, ...(provider ? [provider] : [])) as MirrorDbRow[];
  return rows.map(toMirror);
}

export function getMirror(db: Database.Database, id: number): MirrorRow | null {
  const r = db.prepare('SELECT * FROM memory_mirror WHERE id = ?').get(id) as MirrorDbRow | undefined;
  return r ? toMirror(r) : null;
}
