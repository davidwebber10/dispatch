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
import { importClaudeMemory, noteTextOf } from './import-claude.js';
import { sharedProjectMemoryDir } from '../overseer/memory-scope.js';

/** Decision 1 of the memory spec: Claude Code's own memory stays, and is imported as notes. */
describe('Claude Code memory import', () => {
  let db: Database.Database;
  let home: string;
  let memory: MemoryService;
  let folder: string;
  const run = () => importClaudeMemory({ db, home, memory, projectDir: (w) => w });
  const live = (scope: string) => store.listNotes(db, scope).filter((n) => n.origin === 'import');

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-import-'));
    sessionsDb.create(db, { id: 'A', provider: 'claude-code', name: 'a', workingDir: '/work/a' });
    sessionsDb.create(db, { id: 'B', provider: 'claude-code', name: 'b', workingDir: '/work/b' });
    memory = new MemoryService({ db, projects: () => projectsFromDb(db) });
    folder = sharedProjectMemoryDir(home, '/work/a');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'MEMORY.md'), '# Memory\n- [Tests](testing.md) - how to run tests\n');
    fs.writeFileSync(path.join(folder, 'testing.md'), '---\nname: testing\ndescription: How to run the tests\n---\nRun the suite with FOO=1.\n');
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('imports each file of a project as one note of its scope, once', () => {
    expect(run()).toBe(2);
    const notes = live('project:A');
    expect(notes.map((n) => n.text).sort()).toEqual(['# Memory\n- [Tests](testing.md) - how to run tests', 'How to run the tests\n\nRun the suite with FOO=1.']);
    expect(notes.every((n) => n.origin === 'import' && n.sourceRef?.startsWith('claude-memory:'))).toBe(true);
    expect(live('project:B')).toEqual([]);
    expect(run()).toBe(0); // the next start saves nothing again
    // A Codex thread of the project finds it.
    expect(memory.search('FOO', memory.readableScopes('A')).map((h) => h.kind)).toEqual(['note']);
  });

  it('a changed file replaces its note; a link is not read', () => {
    run();
    fs.writeFileSync(path.join(folder, 'testing.md'), '---\ndescription: How to run the tests\n---\nRun the suite with FOO=2.\n');
    fs.symlinkSync('/etc/hosts', path.join(folder, 'link.md'));
    expect(run()).toBe(1);
    const texts = live('project:A').map((n) => n.text);
    expect(texts.some((t) => t.includes('FOO=2'))).toBe(true);
    expect(texts.some((t) => t.includes('FOO=1'))).toBe(false);
    expect(texts).toHaveLength(2);
  });

  it('nothing while paused or off, or for a project that is not remembered', () => {
    updateMemorySettings(db, { paused: true });
    expect(run()).toBe(0);
    updateMemorySettings(db, { paused: false, projectsOff: ['A'] });
    expect(run()).toBe(0);
    updateMemorySettings(db, { projectsOff: [], enabled: false });
    expect(run()).toBe(0);
  });

  it('a long file is cut to the note limit and names the file', () => {
    const t = noteTextOf(`---\ndescription: d\n---\n${'x'.repeat(5000)}`, '/f/long.md');
    expect(t.length).toBeLessThanOrEqual(store.MAX_NOTE_CHARS);
    expect(t.endsWith('(cut; the whole file: /f/long.md)')).toBe(true);
  });
});
