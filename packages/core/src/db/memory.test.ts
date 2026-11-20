import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from './schema.js';
import * as m from './memory.js';
import { readMemorySettings, updateMemorySettings, DEFAULT_BLOCK_CHARS, MAX_BLOCK_CHARS } from '../memory/settings.js';

describe('memory store (spec 2026-11-17, section 4.2)', () => {
  let db: Database.Database;
  const P = m.projectScope('s1');
  beforeEach(() => { db = new Database(':memory:'); initSchema(db); });

  it('the migration is recorded once and a second initSchema is safe', () => {
    expect(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'memory-1'").get()).toBeTruthy();
    expect(() => initSchema(db)).not.toThrow();
  });

  it('scopes: you and project:<id>; nothing else', () => {
    expect(m.isScope('you')).toBe(true);
    expect(m.isScope(P)).toBe(true);
    for (const bad of ['', 'me', 'project:', 'project:a b', 'company', 'project:../x']) expect(m.isScope(bad), bad).toBe(false);
    expect(m.scopeProject(P)).toBe('s1');
    expect(m.scopeProject('you')).toBeNull();
  });

  it('every page change writes a version; the sha changes with the text', () => {
    const p = m.createPage(db, { scope: P, slug: 'testing', description: 'How to run tests', body: 'Run pnpm test.' }, 'user');
    expect(p).toMatchObject({ slug: 'testing', status: 'active', pinned: false, updatedBy: 'user' });
    const p2 = m.updatePage(db, p.id, { body: 'Run pnpm test with the env removed.', expectedSha: p.sha }, 'user');
    expect(p2.sha).not.toBe(p.sha);
    m.setPinned(db, p.id, true, 'user');
    m.deletePage(db, p.id, 'user');
    const ops = m.listVersions(db, p.id).map((v) => v.op);
    expect(ops).toEqual(['delete', 'pin', 'edit', 'create']);
  });

  it('an edit from an old copy is refused with 409 and changes nothing', () => {
    const p = m.createPage(db, { scope: P, slug: 'a', body: 'one' }, 'user');
    m.updatePage(db, p.id, { body: 'two' }, 'user');
    expect(() => m.updatePage(db, p.id, { body: 'three', expectedSha: p.sha }, 'user')).toThrow(/changed/);
    expect(m.getPage(db, p.id)!.body).toBe('two');
  });

  it('version rows are never changed', () => {
    const p = m.createPage(db, { scope: P, slug: 'a', body: 'one' }, 'user');
    expect(() => db.prepare('UPDATE memory_versions SET body = ? WHERE page_id = ?').run('x', p.id)).toThrow(/never changed/);
  });

  it('limits: slug shape, page size, description length, pages per scope', () => {
    for (const s of ['', 'A', '-a', 'a b', 'a/b', 'x'.repeat(65)]) expect(() => m.createPage(db, { scope: P, slug: s }, 'user'), s).toThrow(/slug/);
    expect(() => m.createPage(db, { scope: P, slug: 'big', body: 'x'.repeat(m.MAX_PAGE_BYTES + 1) }, 'user')).toThrow(/larger/);
    expect(() => m.createPage(db, { scope: P, slug: 'd', description: 'x'.repeat(m.MAX_DESCRIPTION_CHARS + 1) }, 'user')).toThrow(/description/);
    for (let i = 0; i < m.MAX_ACTIVE_PAGES; i++) m.createPage(db, { scope: P, slug: `p${i}` }, 'user');
    expect(() => m.createPage(db, { scope: P, slug: 'one-more' }, 'user')).toThrow(/at most/);
    expect(m.createPage(db, { scope: 'you', slug: 'one-more' }, 'user').scope).toBe('you');
  });

  it('a duplicate slug is refused; a deleted slug comes back on the same row with its history', () => {
    const p = m.createPage(db, { scope: P, slug: 'a', body: 'one' }, 'user');
    expect(() => m.createPage(db, { scope: P, slug: 'a' }, 'user')).toThrow(/exists/);
    m.deletePage(db, p.id, 'user');
    const again = m.createPage(db, { scope: P, slug: 'a', body: 'new' }, 'user');
    expect(again.id).toBe(p.id);
    expect(again.status).toBe('active');
    expect(m.listVersions(db, p.id)).toHaveLength(3);
  });

  it('restore puts an old version back as the newest one', () => {
    const p = m.createPage(db, { scope: P, slug: 'a', body: 'one' }, 'user');
    m.updatePage(db, p.id, { body: 'two' }, 'user');
    m.deletePage(db, p.id, 'user');
    const first = m.listVersions(db, p.id).at(-1)!;
    const r = m.restoreVersion(db, p.id, first.id, 'user');
    expect(r).toMatchObject({ body: 'one', status: 'active' });
    expect(m.listVersions(db, p.id)[0].op).toBe('restore');
  });

  it('search finds active pages and live notes in the given scopes only, and follows edits and deletes', () => {
    const p = m.createPage(db, { scope: P, slug: 'deploy-rules', description: 'Stage and prod', body: 'Deploy with the workflow.' }, 'user');
    m.createPage(db, { scope: m.projectScope('s2'), slug: 'other', body: 'Deploy elsewhere.' }, 'user');
    const n = m.addNote(db, { scope: 'you', text: 'Replies are short.', origin: 'thread', terminalId: 't1', harness: 'codex' });
    expect(m.search(db, 'deploy', [P, 'you']).map((h) => h.slug)).toEqual(['deploy-rules']);
    expect(m.search(db, 'replies', [P, 'you'])).toEqual([expect.objectContaining({ kind: 'note', id: n.id, scope: 'you' })]);
    expect(m.search(db, 'deploy', [P])[0].snippet).toContain(`${m.SNIPPET_OPEN}Deploy${m.SNIPPET_CLOSE}`);
    m.updatePage(db, p.id, { body: 'Ship with the workflow.' }, 'user');
    expect(m.search(db, 'ship', [P])).toHaveLength(1);
    m.deletePage(db, p.id, 'user');
    expect(m.search(db, 'ship', [P])).toHaveLength(0);
    m.deleteNote(db, n.id);
    expect(m.search(db, 'replies', ['you'])).toHaveLength(0);
    m.markRead(db, p.id);
    expect(m.getPage(db, p.id)!.readCount).toBe(1);
  });

  it('search treats FTS syntax as plain words', () => {
    m.addNote(db, { scope: 'you', text: 'A note with "quotes" and NEAR(stuff)', origin: 'user' });
    expect(() => m.search(db, '"quotes AND NEAR( OR *', ['you'])).not.toThrow();
    expect(m.search(db, 'NEAR(stuff', ['you'])).toHaveLength(1);
    expect(m.search(db, 'absent', ['you'])).toHaveLength(0);
    expect(m.search(db, 'quotes', ['you'])).toHaveLength(1);
  });

  it('notes: provenance kept, limits enforced, an import source is saved once', () => {
    const n = m.addNote(db, { scope: P, text: '  Use the ratchet.\r\n ', aboutSlug: 'testing', origin: 'thread', terminalId: 't1', harness: 'claude-code', externalContext: true });
    expect(n).toMatchObject({ text: 'Use the ratchet.', aboutSlug: 'testing', origin: 'thread', terminalId: 't1', harness: 'claude-code', externalContext: true, status: 'new' });
    expect(() => m.addNote(db, { scope: P, text: ' ', origin: 'user' })).toThrow(/empty/);
    expect(() => m.addNote(db, { scope: P, text: 'x'.repeat(m.MAX_NOTE_CHARS + 1), origin: 'user' })).toThrow(/at most/);
    expect(() => m.addNote(db, { scope: P, text: 'x', aboutSlug: 'Bad Slug', origin: 'user' })).toThrow(/about/);
    expect(() => m.addNote(db, { scope: 'nope', text: 'x', origin: 'user' })).toThrow(/scope/);
    const a = m.addNote(db, { scope: P, text: 'imported', origin: 'import', sourceRef: 'claude:abc' });
    const b = m.addNote(db, { scope: P, text: 'imported again', origin: 'import', sourceRef: 'claude:abc' });
    expect(b.id).toBe(a.id);
    expect(m.listNotes(db, P).map((x) => x.id)).toEqual([a.id, n.id]);
    expect(m.listNotes(db, P, { aboutSlug: 'testing' }).map((x) => x.id)).toEqual([n.id]);
  });

  it('scope counts: active pages and new notes', () => {
    m.createPage(db, { scope: P, slug: 'a' }, 'user');
    m.addNote(db, { scope: 'you', text: 'x', origin: 'user' });
    m.addNote(db, { scope: 'you', text: 'y', origin: 'user' });
    expect(m.scopeCounts(db)).toEqual([{ scope: P, pages: 1, newNotes: 0 }, { scope: 'you', pages: 0, newNotes: 2 }]);
  });

  it('off the record is kept per thread and removed with the thread', () => {
    db.prepare("INSERT INTO sessions (id, provider, name, working_dir, created_at, updated_at, last_activity_at) VALUES ('s1','x','p','/tmp','t','t','t')").run();
    db.prepare("INSERT INTO terminals (id, session_id, type, label, created_at) VALUES ('t1','s1','claude-code','T','t')").run();
    expect(m.isOffRecord(db, 't1')).toBe(false);
    m.setOffRecord(db, 't1', true);
    expect(m.isOffRecord(db, 't1')).toBe(true);
    db.prepare("DELETE FROM terminals WHERE id = 't1'").run();
    expect(m.isOffRecord(db, 't1')).toBe(false);
  });
});

describe('memory settings', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initSchema(db); });

  it('defaults, merge, clamp, null clears', () => {
    // Off by default (owner, 2026-11-19); a stored value wins.
    expect(readMemorySettings(db)).toEqual({ enabled: false, paused: false, blockChars: DEFAULT_BLOCK_CHARS, projectsOff: [], providers: { claude: true, codex: true, grok: true } });
    expect(updateMemorySettings(db, { enabled: true }).enabled).toBe(true);
    expect(readMemorySettings(db).enabled).toBe(true);
    expect(updateMemorySettings(db, { paused: true, blockChars: 99999, projectsOff: ['s1', 's1', 'bad id'] }))
      .toMatchObject({ paused: true, blockChars: MAX_BLOCK_CHARS, projectsOff: ['s1'] });
    expect(updateMemorySettings(db, { enabled: 'yes', blockChars: null })).toMatchObject({ enabled: true, paused: true, blockChars: DEFAULT_BLOCK_CHARS });
  });
});
