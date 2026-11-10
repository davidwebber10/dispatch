// ThreadFiles alone: built from its typed inputs, with no SessionService.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { ThreadFiles } from './thread-files.js';

let tmp: string;
let db: Database.Database;
let alive: boolean;
let written: string[];
let files: ThreadFiles;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-thread-files-')));
  fs.mkdirSync(path.join(tmp, 'proj', 'sub'), { recursive: true });
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: path.join(tmp, 'proj') });
  terminalsDb.create(db, { id: 't', sessionId: 's1', type: 'claude-code', label: 't', workingDir: path.join(tmp, 'proj', 'sub') });
  alive = true;
  written = [];
  files = new ThreadFiles({ db, pty: { isAlive: () => alive, write: (_id: string, d: string) => { written.push(d); } } as any });
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ThreadFiles', () => {
  it('resolves a new relative path in the thread folder and refuses a path that leaves the project', () => {
    expect(files.resolveTerminalFilePath('t', 'x.md')).toBe(path.join(tmp, 'proj', 'sub', 'x.md'));
    expect(() => files.resolveTerminalFilePath('t', '../../x.md')).toThrow('Path traversal not allowed');
  });

  it('types a file reference into a live CLI only', () => {
    expect(files.sendFileReference('t', 'x.md', 'shell-path')).toEqual({ sentText: `'${path.join(tmp, 'proj', 'sub', 'x.md')}' ` });
    alive = false;
    expect(() => files.sendFileReference('t', 'x.md')).toThrow('Terminal process is not running');
    expect(written.length).toBe(1);
  });
});
