import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import { SessionService } from './service.js';
import { PTYManager } from '../pty/manager.js';

describe('SessionService.create', () => {
  test('creates the project directory so the first PTY spawn has a cwd', () => {
    // A session row alone is not enough: spawning with a non-existent cwd dies
    // with ENOENT. On a hosted box the user only NAMES a project, so the
    // directory has to be created for them.
    const db = new Database(':memory:');
    initSchema(db);
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-proj-'));
    const dir = path.join(base, 'projects', 'my-new-project');
    const svc = new SessionService(db, new PTYManager(), path.join(base, 'mcp.json'));

    const session = svc.create({ name: 'my-new-project', workingDir: dir } as any);

    expect(fs.existsSync(dir)).toBe(true);
    expect(session.workingDir).toBe(dir);
    fs.rmSync(base, { recursive: true, force: true });
  });

  test('leaves a ~ path alone rather than creating a literal "~" directory', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const svc = new SessionService(db, new PTYManager(), '/tmp/mcp.json');
    const session = svc.create({ name: 'home' } as any);
    expect(session.workingDir).toBe('~');
    expect(fs.existsSync(path.join(process.cwd(), '~'))).toBe(false);
  });
});
