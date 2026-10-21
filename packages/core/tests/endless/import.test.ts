import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import { EndlessStore } from '../../src/endless/store.js';
import { importOnce } from '../../src/endless/import.js';
import { claudeMemoryProjectDir, sharedProjectMemoryDir } from '../../src/overseer/memory-scope.js';

describe('importOnce', () => {
  it('imports each project MEMORY.md and open items as one note per project, once', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'endless-import-'));
    const home = path.join(root, 'home');
    const proj = path.join(root, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    const memDir = sharedProjectMemoryDir(home, claudeMemoryProjectDir(proj).dir!);
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '# Memory\n- uses pnpm\n');

    const db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'proj', workingDir: proj });
    sessionsDb.create(db, { id: 's2', provider: 'claude-code', name: 'empty', workingDir: path.join(root, 'none') });
    db.prepare("INSERT INTO ledger_items (session_id, seq, kind, text, author, created_at, updated_at) VALUES ('s1', 4, 'decide', 'pick a db', 'overseer', 'x', 'x')").run();
    const store = new EndlessStore(db);
    const logged: any[] = [];
    const log = (input: any) => { logged.push(input); return store.append(input); };

    expect(importOnce({ db, store, home, log })).toBe(1);
    expect(logged).toEqual([{ kind: 'note', project: 's1', text: `Memories imported for proj (${proj}):\n\nMEMORY.md:\n# Memory\n- uses pnpm\n\nOpen items:\n- N4 pick a db` }]);
    expect(store.getState('imported')).toBe('1');
    expect(importOnce({ db, store, home, log })).toBe(0);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
