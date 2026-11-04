// packages/core/src/routes/git-fsmonitor.test.ts
// SEC sweep SUS-3: a repository's own .git/config can set core.fsmonitor to a command, and git runs that
// command on status, diff and ls-files. The daemon runs git in project folders, so none of its calls may run it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import { createGitRouter } from './git.js';
import { createFilesRouter } from './files.js';
import { git } from '../docs/git.js';

let dir: string;
let marker: string;

function sh(args: string[]): void {
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { stdio: 'ignore' });
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-fsmon-')));
  marker = path.join(dir, '..', `${path.basename(dir)}.marker`);
  sh(['init', '-q', '.']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  sh(['add', 'a.txt']);
  sh(['commit', '-qm', 'i']);
  // The hook records that it ran. Written after the commit so only the daemon's calls can trip it.
  const hook = path.join(dir, '..', `${path.basename(dir)}.hook.sh`);
  fs.writeFileSync(hook, `#!/bin/sh\necho ran >> "${marker}"\nexit 1\n`, { mode: 0o755 });
  sh(['config', 'core.fsmonitor', hook]);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'new');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(marker, { force: true });
  fs.rmSync(path.join(dir, '..', `${path.basename(dir)}.hook.sh`), { force: true });
});

function app() {
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 't', workingDir: dir });
  const a = express();
  a.use(express.json());
  a.use('/api/sessions/:id/git', createGitRouter(db));
  a.use('/api/sessions/:id/files', createFilesRouter(db));
  return a;
}

describe('git calls never run a repository\'s core.fsmonitor command', () => {
  it('sanity: the hook does run for a plain git status', () => {
    execFileSync('git', ['-C', dir, 'status', '--porcelain'], { stdio: 'ignore' });
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('GET /git/status lists the changes and does not run it', async () => {
    const res = await request(app()).get('/api/sessions/s1/git/status');
    expect(res.status).toBe(200);
    expect(res.body.files.map((f: any) => f.path).sort()).toEqual(['a.txt', 'new.txt']);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('GET /files/flat (git ls-files) does not run it', async () => {
    const res = await request(app()).get('/api/sessions/s1/files/flat');
    expect(res.status).toBe(200);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('the docs git helper (diff, status, ls-files) does not run it', () => {
    expect(git(dir, ['status', '--porcelain'])).toContain('a.txt');
    git(dir, ['diff', '--name-only']);
    git(dir, ['ls-files', '-o']);
    expect(fs.existsSync(marker)).toBe(false);
  });
});
