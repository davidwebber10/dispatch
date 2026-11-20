import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import * as store from '../db/memory.js';
import { MemoryError, YOU, projectScope, scopeProject, type MemoryScope, type MemoryPage, type MemoryNote, type MemorySearchHit } from '../db/memory.js';
import { readMemorySettings, updateMemorySettings, projectRemembered, providerRead, type MemorySettings } from './settings.js';
import { buildBlock } from './block.js';
import { HARNESS_PROVIDERS, type MemoryProvider, type ProviderId, type ProviderScope, type ProviderEntry, type ProviderStatus, type ProviderCapabilities } from './providers/index.js';

/**
 * Memory (docs/superpowers/specs/2026-11-17-memory-design.md). The composition root: scopes, pages,
 * notes, search, the block, and the rules for a thread. Routes and tools come here; only
 * db/memory.ts touches the tables. No model is called anywhere in phase 1.
 *
 * Who may do what:
 *   the person   every scope; edits pages; adds and deletes notes; settings.
 *   a thread     reads and searches "You" and its own project's scope; adds notes there (`remember`).
 *                Never another project's scope. Never a page write. Refused when its thread is off the
 *                record, when memory is paused or off, or when its project is not remembered.
 */

export interface MemoryProject { id: string; name: string; archived: boolean }
/** A thread, as its key names it (the daemon's records, never the request body). */
export interface ThreadCaller { terminalId: string; sessionId: string; harness: string }
export interface ScopeInfo { scope: MemoryScope; label: string; projectId: string | null; pages: number; newNotes: number; remembered: boolean; archived: boolean }
export type MemoryEvent = { type: 'memory:changed'; scope: MemoryScope };

export interface MemoryDeps {
  db: Database.Database;
  /** Every project (session), for scope names. */
  projects: () => MemoryProject[];
  broadcast?: (e: MemoryEvent) => void;
  /** True under the hosted business profile: memory is off there until a host turns it on (phase 4). */
  business?: () => boolean;
  /** The newest journal seq of a thread, recorded with its notes as provenance. */
  lastSeq?: (terminalId: string) => number | null;
  /**
   * Memory became active (turned on, or no longer paused): the background work that waited runs once
   * now (the conversation catch-up and the Claude Code import), then as designed.
   */
  onActive?: () => void;
  /** The memory providers (memory/providers): Dispatch mirrors the harness ones. Absent: no mirror. */
  providers?: Partial<Record<ProviderId, MemoryProvider>>;
}

export interface ProviderInfo { id: ProviderId; label: string; status: ProviderStatus; capabilities: ProviderCapabilities; reading: boolean; entries: number }
export type EntryWriteAnswer = { ok: true; entry: store.MirrorRow | null } | { ok: false; conflict: true; current: ProviderEntry | null } | { ok: false; conflict: false; error: string };
/** An entry reference for a thread: `<provider>:<mirror id>` (a page slug never holds a colon). */
export const ENTRY_REF = /^(claude|codex|grok):(\d{1,12})$/;

/** Every project from the sessions table, archived ones too (their memory stays until the person deletes it). */
export function projectsFromDb(db: Database.Database): MemoryProject[] {
  return (db.prepare('SELECT id, name, archived_at FROM sessions ORDER BY sort_order ASC, last_activity_at DESC').all() as { id: string; name: string; archived_at: string | null }[])
    .map((r) => ({ id: r.id, name: r.name, archived: !!r.archived_at }));
}

export class MemoryService {
  constructor(private readonly deps: MemoryDeps) {}

  private get db() { return this.deps.db; }

  private changed(scope: MemoryScope): void {
    try { this.deps.broadcast?.({ type: 'memory:changed', scope }); } catch (err) { console.warn('[memory] broadcast failed:', err); }
  }

  settings(): MemorySettings & { available: boolean } { return { ...readMemorySettings(this.db), available: this.available() }; }

  updateSettings(patch: unknown): MemorySettings & { available: boolean } {
    const before = this.active();
    const beforeOff = new Set(readMemorySettings(this.db).projectsOff);
    updateMemorySettings(this.db, patch);
    this.changed(YOU);
    // Off to on (or a pause ended, or a project is remembered again): run the catch-up once.
    const back = readMemorySettings(this.db).projectsOff.length < beforeOff.size;
    if (this.active() && (!before || back)) {
      try { this.deps.onActive?.(); } catch (err) { console.warn('[memory] catch-up failed to start:', err); }
    }
    return this.settings();
  }

  /** On, and not under the business profile. */
  available(): boolean {
    return readMemorySettings(this.db).enabled && !this.deps.business?.();
  }

  /** Available and not paused: new things are saved (notes from threads, conversation words). */
  active(): boolean {
    return this.available() && !readMemorySettings(this.db).paused;
  }

  /** A thread whose words memory does not keep: off the record, or its project is not remembered. */
  keepsOut(terminalId: string): boolean {
    if (this.offRecord(terminalId)) return true;
    const t = terminalsDb.getById(this.db, terminalId);
    return !t || !projectRemembered(readMemorySettings(this.db), t.session_id);
  }

  /**
   * Search past conversations (layer 1). A thread: its own project's threads only, and nothing when its
   * project is not remembered. The person: every project, or the one named.
   */
  searchConversations(q: string, caller: ThreadCaller | null, project: string | null, limit?: number): store.TurnHit[] {
    if (caller) {
      const sessions = projectRemembered(readMemorySettings(this.db), caller.sessionId) ? [caller.sessionId] : [];
      return store.searchTurns(this.db, q, sessions, limit);
    }
    return store.searchTurns(this.db, q, project ? [project] : null, limit);
  }

  // ---- scopes ----

  scopes(): ScopeInfo[] {
    const counts = new Map(store.scopeCounts(this.db).map((c) => [c.scope, c]));
    const s = readMemorySettings(this.db);
    const you = counts.get(YOU);
    const out: ScopeInfo[] = [{ scope: YOU, label: 'You', projectId: null, pages: you?.pages ?? 0, newNotes: you?.newNotes ?? 0, remembered: true, archived: false }];
    const seen = new Set<string>([YOU]);
    for (const p of this.deps.projects()) {
      const scope = projectScope(p.id);
      const c = counts.get(scope);
      if (p.archived && !c) continue;
      seen.add(scope);
      out.push({ scope, label: p.name, projectId: p.id, pages: c?.pages ?? 0, newNotes: c?.newNotes ?? 0, remembered: projectRemembered(s, p.id), archived: p.archived });
    }
    // A scope whose project was deleted keeps its memory until the person deletes it.
    for (const [scope, c] of counts) {
      if (seen.has(scope)) continue;
      const id = scopeProject(scope);
      out.push({ scope, label: id ? `Deleted project ${id.slice(0, 8)}` : scope, projectId: id, pages: c.pages, newNotes: c.newNotes, remembered: false, archived: true });
    }
    return out;
  }

  /** The scopes a thread of this project reads: You, and its project when remembered. */
  readableScopes(sessionId: string | null): MemoryScope[] {
    const out: MemoryScope[] = [YOU];
    if (sessionId && projectRemembered(readMemorySettings(this.db), sessionId)) out.push(projectScope(sessionId));
    return out;
  }

  /** Throws 403 unless a thread may read this scope. */
  checkThreadScope(caller: ThreadCaller, scope: MemoryScope): void {
    if (!this.readableScopes(caller.sessionId).includes(scope)) throw new MemoryError('This thread may use only the memory of "you" and of its own project.', 403);
  }

  // ---- pages (the person) ----

  listPages(scope: MemoryScope) { return store.listPages(this.db, scope); }

  /** A page with the newer notes about it (section 4.3: a correction is visible at once). */
  page(id: number): { page: MemoryPage; notes: MemoryNote[] } {
    const page = store.getPage(this.db, id);
    if (!page || page.status === 'deleted') throw new MemoryError('no such page', 404);
    return { page, notes: this.notesAbout(page) };
  }

  private notesAbout(page: MemoryPage): MemoryNote[] {
    return store.listNotes(this.db, page.scope, { status: 'new', aboutSlug: page.slug, limit: 50 });
  }

  createPage(input: { scope: MemoryScope; slug: string; description?: string; body?: string; pinned?: boolean }): MemoryPage {
    const page = store.createPage(this.db, input, 'user');
    this.changed(page.scope);
    return page;
  }

  updatePage(id: number, patch: { description?: string; body?: string; expectedSha?: string; pinned?: boolean }): MemoryPage {
    let page = store.updatePage(this.db, id, patch, 'user');
    if (typeof patch.pinned === 'boolean') page = store.setPinned(this.db, id, patch.pinned, 'user');
    this.changed(page.scope);
    return page;
  }

  deletePage(id: number): MemoryPage {
    const page = store.deletePage(this.db, id, 'user');
    this.changed(page.scope);
    return page;
  }

  versions(id: number) {
    if (!store.getPage(this.db, id)) throw new MemoryError('no such page', 404);
    return store.listVersions(this.db, id);
  }

  restore(id: number, versionId: number): MemoryPage {
    const page = store.restoreVersion(this.db, id, versionId, 'user');
    this.changed(page.scope);
    return page;
  }

  // ---- notes ----

  notes(scope: MemoryScope, status?: 'new' | 'used' | 'live') { return store.listNotes(this.db, scope, { status: status ?? 'live' }); }

  /** A note the person writes in the Memory tab (works while paused: pause stops automatic saves only). */
  addUserNote(input: { scope: MemoryScope; text: string; about?: string | null }): MemoryNote {
    const note = store.addNote(this.db, { scope: input.scope, text: input.text, aboutSlug: input.about ?? null, origin: 'user', askedByUser: true });
    this.changed(note.scope);
    return note;
  }

  deleteNote(id: number): void {
    const note = store.getNote(this.db, id);
    if (!note || !store.deleteNote(this.db, id)) throw new MemoryError('no such note', 404);
    this.changed(note.scope);
  }

  // ---- search ----

  search(q: string, scopes: MemoryScope[], limit?: number): MemorySearchHit[] { return store.search(this.db, q, scopes, limit); }

  /** Every scope that holds something, for the person's search across all of memory. */
  allScopes(): MemoryScope[] { return this.scopes().map((s) => s.scope); }

  // ---- threads ----

  offRecord(terminalId: string): boolean { return store.isOffRecord(this.db, terminalId); }

  setOffRecord(terminalId: string, off: boolean): void {
    if (!terminalsDb.getById(this.db, terminalId)) throw new MemoryError('no such thread', 404);
    store.setOffRecord(this.db, terminalId, off);
  }

  /**
   * `remember` from a thread. `scope` 'you' or 'project' (default: the project, or You when the
   * project is not remembered). `about` names a page; a page of the other readable scope moves the
   * note there.
   */
  remember(caller: ThreadCaller, input: { text: unknown; about?: unknown; scope?: unknown }): MemoryNote {
    if (!this.available()) throw new MemoryError('Memory is off.', 403);
    const s = readMemorySettings(this.db);
    if (s.paused) throw new MemoryError('Memory is paused: nothing new is saved.', 403);
    if (this.offRecord(caller.terminalId)) throw new MemoryError('This thread is off the record: it cannot save to memory.', 403);
    const readable = this.readableScopes(caller.sessionId);
    const project = projectScope(caller.sessionId);
    let scope: MemoryScope;
    if (input.scope === 'you') scope = YOU;
    else if (input.scope === 'project') {
      if (!readable.includes(project)) throw new MemoryError('Memory is off for this project. Save it for "you", or not at all.', 403);
      scope = project;
    } else if (input.scope !== undefined && input.scope !== null) throw new MemoryError('scope is "you" or "project"');
    else scope = readable.includes(project) ? project : YOU;
    const about = typeof input.about === 'string' && input.about ? input.about : null;
    if (about && input.scope == null) {
      const other = readable.find((sc) => sc !== scope && store.getPageBySlug(this.db, sc, about)?.status === 'active');
      if (other && !(store.getPageBySlug(this.db, scope, about)?.status === 'active')) scope = other;
    }
    const note = store.addNote(this.db, {
      scope, text: typeof input.text === 'string' ? input.text : '', aboutSlug: about, origin: 'thread',
      terminalId: caller.terminalId, harness: caller.harness, seqTo: this.deps.lastSeq?.(caller.terminalId) ?? null,
    });
    this.changed(note.scope);
    return note;
  }

  /** `memory_read` from a thread: a page of its readable scopes by slug (its project first), counted as a read. */
  readForThread(caller: ThreadCaller, slug: string, scope?: 'you' | 'project'): { page: MemoryPage; notes: MemoryNote[] } {
    if (!this.available()) throw new MemoryError('Memory is off.', 403);
    const readable = this.readableScopes(caller.sessionId);
    const order = scope === 'you' ? [YOU] : scope === 'project' ? readable.filter((s) => s !== YOU) : [...readable].reverse();
    for (const sc of order) {
      const page = store.getPageBySlug(this.db, sc, slug);
      if (page && page.status === 'active') {
        store.markRead(this.db, page.id);
        return { page: store.getPage(this.db, page.id)!, notes: this.notesAbout(page) };
      }
    }
    throw new MemoryError(`no page "${slug}" in this thread's memory`, 404);
  }

  // ---- the block ----

  /**
   * The exact text a thread of this project gets ('' when memory is not available): the pointer and the
   * pages the person pinned in You and in this project (design review 2026-11-19: tools first).
   */
  block(sessionId: string | null, _harness?: string): string {
    if (!this.available()) return '';
    const pinned = this.readableScopes(sessionId).flatMap((sc) => store.listPages(this.db, sc)
      .filter((p) => p.status === 'active' && p.pinned)
      .map((p) => ({ slug: p.slug, description: p.description, scope: (sc === YOU ? 'you' : 'project') as 'you' | 'project' })));
    return buildBlock({ pinned, cap: readMemorySettings(this.db).blockChars });
  }

  // ---- the index (memory_search with no query) ----

  /** What memory holds for these scopes: the pages, the newest notes, the mirrored entries; each with its source. */
  index(scopes: MemoryScope[]) {
    const pages = scopes.flatMap((sc) => store.listPages(this.db, sc).filter((p) => p.status === 'active')
      .map((p) => ({ kind: 'page' as const, slug: p.slug, description: p.description, scope: sc, pinned: p.pinned, source: 'dispatch' })));
    const notes = scopes.flatMap((sc) => store.listNotes(this.db, sc, { status: 'new', limit: 10 })).sort((a, b) => b.id - a.id).slice(0, 10)
      .map((n) => ({ kind: 'note' as const, id: n.id, text: n.text, about: n.aboutSlug, scope: n.scope, at: n.createdAt, source: 'dispatch' }));
    const entries = store.listMirror(this.db, scopes).slice(0, 50)
      .map((e) => ({ kind: 'entry' as const, ref: `${e.provider}:${e.id}`, title: e.title, description: e.description, scope: e.scope, source: e.provider }));
    return { pages, notes, entries };
  }

  // ---- providers and the mirror (spec 4.8) ----

  private provider(id: string): MemoryProvider {
    const p = this.deps.providers?.[id as ProviderId];
    if (!p) throw new MemoryError(`no memory provider "${id}"`, 404);
    return p;
  }

  /** The provider view of a scope: a project needs its working folder. */
  private providerScope(scope: MemoryScope): ProviderScope | null {
    if (scope === YOU) return { scope: 'you' };
    const id = scopeProject(scope);
    const row = id ? this.db.prepare('SELECT working_dir FROM sessions WHERE id = ?').get(id) as { working_dir: string } | undefined : undefined;
    return row ? { scope: scope as `project:${string}`, workingDir: row.working_dir } : null;
  }

  /** The providers with their state, the Dispatch switch, and how many entries the mirror holds. */
  providersInfo(sessionId: string | null): ProviderInfo[] {
    const s = readMemorySettings(this.db);
    const ref = sessionId ? this.providerScope(projectScope(sessionId)) : null;
    const scopes = this.readableScopes(sessionId);
    return Object.values(this.deps.providers ?? {}).map((p) => {
      const harness = p.id !== 'dispatch';
      return {
        id: p.id, label: p.label, status: p.status(ref), capabilities: p.capabilities,
        reading: !harness || (p.capabilities.scopes.length > 0 && providerRead(s, p.id)),
        entries: harness ? store.listMirror(this.db, scopes, p.id).length : scopes.reduce((n, sc) => n + store.listPages(this.db, sc).length, 0),
      };
    });
  }

  /**
   * Make the mirror equal to the files (spec 4.8): for each harness provider that Dispatch reads, each
   * scope (You and the remembered projects; only the given project when a thread settled). A provider that
   * Dispatch does not read loses its rows. Nothing is read while memory is off. Returns the rows changed.
   */
  syncProviders(opts: { sessionId?: string } = {}): number {
    if (!this.available() || !this.deps.providers || !this.db.open) return 0;
    const s = readMemorySettings(this.db);
    const scopes: MemoryScope[] = opts.sessionId
      ? this.readableScopes(opts.sessionId)
      : [YOU, ...this.deps.projects().filter((p) => !p.archived && projectRemembered(s, p.id)).map((p) => projectScope(p.id))];
    let changed = 0;
    for (const id of HARNESS_PROVIDERS) {
      const p = this.deps.providers[id];
      if (!p) continue;
      if (!providerRead(s, id)) { changed += store.clearMirror(this.db, id); continue; }
      for (const sc of scopes) {
        const kind = sc === YOU ? 'you' : 'project';
        if (!p.capabilities.scopes.includes(kind)) continue;
        const ref = this.providerScope(sc);
        if (!ref) continue;
        let entries: ProviderEntry[];
        try { entries = p.list(ref); } catch (err) { console.warn(`[memory] could not read ${id}:`, err); continue; }
        changed += store.syncMirror(this.db, id, sc, entries.map((e) => ({ ...e, path: null })));
      }
    }
    if (changed) this.changed(YOU);
    return changed;
  }

  /** "Dispatch reads this provider" (the harness's own switch is not touched). */
  setProviderRead(id: string, on: boolean): ProviderInfo[] {
    if (!(HARNESS_PROVIDERS as readonly string[]).includes(id) || id === 'opencode') throw new MemoryError('this provider has no memory to read');
    updateMemorySettings(this.db, { providers: { [id]: on } });
    if (on) this.syncProviders(); else if (store.clearMirror(this.db, id)) this.changed(YOU);
    return this.providersInfo(null);
  }

  entries(scopes: MemoryScope[], provider?: string) { return store.listMirror(this.db, scopes, provider); }

  /** One mirrored entry; a thread only in its own scopes. */
  entry(id: number, caller: ThreadCaller | null): store.MirrorRow {
    const e = store.getMirror(this.db, id);
    if (!e) throw new MemoryError('no such entry', 404);
    if (caller) this.checkThreadScope(caller, e.scope);
    return e;
  }

  /**
   * Write-through from the screen (the person only): the provider re-reads its file and compares the sha;
   * a changed file is a conflict and nothing is written (the file always wins). Then the scope is synced.
   */
  writeEntry(providerId: string, scope: MemoryScope, input: { rel?: string; title?: unknown; description?: unknown; text?: unknown }, expectedSha: string | null): EntryWriteAnswer {
    const p = this.provider(providerId);
    if (!p.write || p.capabilities.write === 'none') throw new MemoryError(`${p.label} cannot be written from Dispatch`, 400);
    const ref = this.providerScope(scope);
    if (!ref) throw new MemoryError('bad scope', 400);
    const text = typeof input.text === 'string' ? input.text : '';
    if (!text.trim()) throw new MemoryError('empty entry');
    const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : text.trim().split('\n')[0].slice(0, 60);
    const r = p.write(ref, { rel: input.rel, title, description: typeof input.description === 'string' ? input.description : '', text }, expectedSha);
    if (!r.ok) return r;
    this.syncProviders({ sessionId: scopeProject(scope) ?? undefined });
    const row = store.listMirror(this.db, [scope], providerId).find((e) => e.rel === r.rel) ?? null;
    return { ok: true, entry: row };
  }

  /** Delete through the provider (the file, and its index line for Claude), when the file is the one the person saw. */
  removeEntry(id: number, expectedSha: string): EntryWriteAnswer {
    const e = this.entry(id, null);
    const p = this.provider(e.provider);
    if (!p.remove || !p.capabilities.delete) throw new MemoryError(`${p.label} entries cannot be deleted from Dispatch`, 400);
    const ref = this.providerScope(e.scope);
    if (!ref) throw new MemoryError('bad scope', 400);
    const r = p.remove(ref, e.rel, expectedSha);
    if (!r.ok) return r;
    this.syncProviders({ sessionId: scopeProject(e.scope) ?? undefined });
    return { ok: true, entry: null };
  }

  /** The prompt parts for a spawn, beside the skills (daemon/build.ts). */
  injection(sessionId: string | null, harness: string): string[] {
    const text = this.block(sessionId, harness);
    return text ? [text] : [];
  }
}
