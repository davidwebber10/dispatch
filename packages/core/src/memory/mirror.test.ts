import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as store from '../db/memory.js';
import { MemoryService, projectsFromDb } from './service.js';
import { updateMemorySettings } from './settings.js';
import { buildProviders } from './providers/index.js';
import { sharedProjectMemoryDir } from '../overseer/memory-scope.js';

/** The provider mirror (spec 4.8): the harness file is the truth; the mirror follows it. */
describe('provider mirror', () => {
  let db: Database.Database;
  let home: string;
  let memory: MemoryService;
  let dir: string;
  const file = (n: string) => path.join(dir, n);

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-mirror-'));
    sessionsDb.create(db, { id: 'A', provider: 'claude-code', name: 'a', workingDir: '/work/a' });
    dir = sharedProjectMemoryDir(home, '/work/a');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file('MEMORY.md'), '- [Testing](testing.md) — tests\n');
    fs.writeFileSync(file('testing.md'), '---\nname: testing\ndescription: How to run tests\n---\nRun with FOO=1.\n');
    memory = new MemoryService({ db, projects: () => projectsFromDb(db), providers: buildProviders({ db, home, env: {}, projectDir: (w) => w }) });
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('reads nothing while memory is off (the default)', () => {
    expect(memory.syncProviders()).toBe(0);
    expect(store.listMirror(db, ['project:A'])).toEqual([]);
  });

  it('create, change and delete follow the files; search finds an entry with its source; no import notes', () => {
    updateMemorySettings(db, { enabled: true });
    expect(memory.syncProviders()).toBe(1);
    const [row] = store.listMirror(db, ['project:A']);
    expect(row).toMatchObject({ provider: 'claude', rel: 'testing.md', title: 'testing' });
    expect(memory.search('FOO', ['project:A'])).toEqual([expect.objectContaining({ kind: 'entry', id: row.id, source: 'claude' })]);
    expect(store.listNotes(db, 'project:A')).toEqual([]);
    expect(memory.syncProviders()).toBe(0); // same sha: nothing to do
    fs.writeFileSync(file('testing.md'), '---\nname: testing\n---\nRun with BAR=2.\n');
    expect(memory.syncProviders()).toBe(1);
    expect(memory.search('FOO', ['project:A'])).toEqual([]);
    expect(memory.search('BAR', ['project:A'])).toHaveLength(1);
    fs.rmSync(file('testing.md'));
    expect(memory.syncProviders()).toBe(1);
    expect(store.listMirror(db, ['project:A'])).toEqual([]);
  });

  it('"Dispatch reads it" off forgets the mirror; on brings it back', () => {
    updateMemorySettings(db, { enabled: true });
    memory.syncProviders();
    memory.setProviderRead('claude', false);
    expect(store.listMirror(db, ['project:A'])).toEqual([]);
    expect(memory.providersInfo('A').find((p) => p.id === 'claude')).toMatchObject({ reading: false });
    memory.setProviderRead('claude', true);
    expect(store.listMirror(db, ['project:A'])).toHaveLength(1);
  });

  it('write-through: a stale sha returns the new text and stops; a fresh one writes the file, then the mirror', () => {
    updateMemorySettings(db, { enabled: true });
    memory.syncProviders();
    const [row] = store.listMirror(db, ['project:A']);
    fs.writeFileSync(file('testing.md'), 'changed by Claude\n');
    const stale = memory.writeEntry('claude', 'project:A', { rel: row.rel, text: 'mine' }, row.sha);
    expect(stale).toMatchObject({ ok: false, conflict: true, current: { text: 'changed by Claude\n' } });
    expect(fs.readFileSync(file('testing.md'), 'utf8')).toBe('changed by Claude\n');
    memory.syncProviders();
    const fresh = store.listMirror(db, ['project:A'])[0];
    expect(memory.writeEntry('claude', 'project:A', { rel: fresh.rel, text: 'mine' }, fresh.sha)).toMatchObject({ ok: true, entry: { text: 'mine' } });
    expect(fs.readFileSync(file('testing.md'), 'utf8')).toBe('mine');
    const added = memory.writeEntry('claude', 'project:A', { title: 'Deploy', text: 'Stage first.' }, null);
    expect(added).toMatchObject({ ok: true, entry: { rel: 'deploy.md', provider: 'claude' } });
  });

  it('the index (memory_search with no query) lists pages, notes and entries, each with its source', () => {
    updateMemorySettings(db, { enabled: true });
    memory.syncProviders();
    memory.createPage({ scope: 'you', slug: 'how-i-work', description: 'Short replies' });
    memory.addUserNote({ scope: 'project:A', text: 'Use the base commit.' });
    const ix = memory.index(memory.readableScopes('A'));
    expect(ix.pages).toEqual([expect.objectContaining({ slug: 'how-i-work', source: 'dispatch' })]);
    expect(ix.notes).toEqual([expect.objectContaining({ text: 'Use the base commit.', source: 'dispatch' })]);
    expect(ix.entries).toEqual([expect.objectContaining({ ref: expect.stringMatching(/^claude:\d+$/), title: 'testing', source: 'claude' })]);
  });
});
