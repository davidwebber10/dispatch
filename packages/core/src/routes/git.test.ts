import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { createPrincipalMiddleware } from '../auth/request-principal.js';
import { createKeyScope } from '../auth/key-scope.js';
import { KeyRegistry } from '../auth/principals.js';
import { GATE_VIA } from '../auth/access-gate.js';
import { configureRefusalLog } from '../auth/route-policy.js';
import { makeRepo, gitIn, type TestRepo } from '../git/repo.fixture.js';
import { parsePorcelainZ, createGitRouter, createWorktreesRouter } from './git.js';

// Records come straight from `git status --porcelain -z`: NUL-terminated,
// paths verbatim (no quoting), and a rename carries the OLD path as an extra field.
const z = (...recs: string[]) => recs.join('\0') + '\0';

describe('parsePorcelainZ', () => {
  it('maps the common cases to one UI letter each', () => {
    const files = parsePorcelainZ(z(' M packages/web/src/App.tsx', 'A  new.ts', ' D gone.ts', '?? scratch.txt'));
    expect(files).toEqual([
      { path: 'packages/web/src/App.tsx', status: 'M' },
      { path: 'new.ts', status: 'A' },
      { path: 'gone.ts', status: 'D' },
      { path: 'scratch.txt', status: '?' },
    ]);
  });

  it('consumes the rename old-path field so the next record is not misread', () => {
    const files = parsePorcelainZ(z('R  renamed.ts', 'old.ts', ' M other.ts'));
    expect(files).toEqual([
      { path: 'renamed.ts', status: 'R' },
      { path: 'other.ts', status: 'M' },
    ]);
  });

  it('keeps paths with spaces intact and ignores the trailing empty field', () => {
    const files = parsePorcelainZ(z(' M docs/My Notes.md'));
    expect(files).toEqual([{ path: 'docs/My Notes.md', status: 'M' }]);
  });

  it('returns [] for empty output', () => {
    expect(parsePorcelainZ('')).toEqual([]);
  });
});

// W3-G: diff review (diff, approve, discard) and a worktree for one thread.
const TOKEN = 'owner-access-token-for-the-test-0123456789';

describe('diff review and worktree routes', () => {
  let repo: TestRepo;
  let other: TestRepo;
  beforeEach(() => { repo = makeRepo(); other = makeRepo(); configureRefusalLog({ log: () => {} }); });
  afterEach(() => { repo.cleanup(); other.cleanup(); });

  function appWith(via: 'local' | 'test' = 'test') {
    const db = new Database(':memory:'); initSchema(db);
    sessionsDb.create(db, { id: 'S', provider: 'claude-code', name: 's', workingDir: repo.dir });
    sessionsDb.create(db, { id: 'S2', provider: 'claude-code', name: 's2', workingDir: other.dir });
    terminalsDb.create(db, { id: 't1', sessionId: 'S', type: 'claude-code', label: 'one' });
    terminalsDb.create(db, { id: 'x1', sessionId: 'S2', type: 'claude-code', label: 'other project', workingDir: other.dir });
    const reg = new KeyRegistry();
    const app = express();
    app.use((req, _res, next) => { if (via !== 'test') (req as any)[GATE_VIA] = via; next(); });
    app.use(createPrincipalMiddleware({ registry: reg, scope: createKeyScope(db), getToken: () => TOKEN, via: 'test' }));
    app.use(express.json());
    const secretRoots = { home: path.join(repo.dir, 'no-home'), dataDir: path.join(repo.dir, 'no-data') };
    app.use('/api/sessions/:id/git', createGitRouter(db, { secretRoots }));
    app.use('/api/sessions/:id/worktrees', createWorktreesRouter(db));
    return { app, db, reg };
  }

  it('GET /diff lists the changes of the thread directory', async () => {
    const { app, db } = appWith();
    repo.write('a.txt', 'one\nTWO\nthree\n');
    repo.write('new.txt', 'n\n');
    const res = await request(app).get('/api/sessions/S/git/diff?terminalId=t1');
    expect(res.status).toBe(200);
    expect(res.body.files.map((f: any) => [f.path, f.status])).toEqual([['a.txt', 'modified'], ['new.txt', 'untracked']]);
    expect(res.body).toMatchObject({ truncated: false, shared: false, repo: true, branch: 'main', workDir: repo.dir });
    // A second live thread in the same directory: the changes can come from either.
    terminalsDb.create(db, { id: 't2', sessionId: 'S', type: 'claude-code', label: 'two' });
    expect((await request(app).get('/api/sessions/S/git/diff?terminalId=t1')).body.shared).toBe(true);
    // An archived thread does not count.
    terminalsDb.archive(db, 't2');
    expect((await request(app).get('/api/sessions/S/git/diff?terminalId=t1')).body.shared).toBe(false);
    const one = await request(app).get('/api/sessions/S/git/diff?terminalId=t1&path=new.txt');
    expect(one.body.files.map((f: any) => f.path)).toEqual(['new.txt']);
  });

  it('GET /diff of a thread in a worktree shows the worktree, not the project', async () => {
    const { app, db } = appWith();
    const wt = (await request(app).post('/api/sessions/S/worktrees').send({ name: 'side' })).body;
    terminalsDb.create(db, { id: 'tw', sessionId: 'S', type: 'claude-code', label: 'side', workingDir: wt.path });
    fs.writeFileSync(path.join(wt.path, 'b.txt'), 'changed in the worktree\n');
    repo.write('a.txt', 'changed in the project\n');
    const inWt = await request(app).get('/api/sessions/S/git/diff?terminalId=tw');
    expect(inWt.body.files.map((f: any) => f.path)).toEqual(['b.txt']);
    expect(inWt.body.branch).toBe('dispatch/side');
    const inProject = await request(app).get('/api/sessions/S/git/diff?terminalId=t1');
    expect(inProject.body.files.map((f: any) => f.path)).toEqual(['a.txt']);
  });

  it('a thread of another project is refused: its directory is never used', async () => {
    const { app } = appWith();
    other.write('a.txt', 'work in the other project\n');
    expect((await request(app).get('/api/sessions/S/git/diff?terminalId=x1')).status).toBe(404);
    expect((await request(app).post('/api/sessions/S/git/discard').send({ terminalId: 'x1', paths: ['a.txt'] })).status).toBe(404);
    expect((await request(app).post('/api/sessions/S/git/approve').send({ terminalId: 'x1', paths: ['a.txt'] })).status).toBe(404);
    expect((await request(app).get('/api/sessions/nope/git/diff')).status).toBe(404);
    expect(other.read('a.txt')).toBe('work in the other project\n');
    expect(other.status()).toBe(' M a.txt\n');
  });

  it('approve stages only the listed paths', async () => {
    const { app } = appWith();
    repo.write('a.txt', 'edited\n');
    repo.write('b.txt', 'edited too\n');
    repo.write('new.txt', 'n\n');
    const head = repo.git('rev-parse', 'HEAD').trim();
    const res = await request(app).post('/api/sessions/S/git/approve').send({ terminalId: 't1', paths: ['a.txt'] });
    expect(res.status).toBe(200);
    expect(res.body.staged).toEqual(['a.txt']);
    expect(repo.status()).toBe('M  a.txt\n M b.txt\n?? new.txt\n');
    expect(repo.git('rev-parse', 'HEAD').trim()).toBe(head);
    const diff = await request(app).get('/api/sessions/S/git/diff?terminalId=t1');
    expect(diff.body.files.map((f: any) => [f.path, f.staged])).toEqual([['a.txt', true], ['b.txt', false], ['new.txt', false]]);
  });

  it('discard restores a tracked file and removes an untracked file', async () => {
    const { app } = appWith();
    repo.write('a.txt', 'edited\n');
    repo.write('b.txt', 'unrelated edit\n');
    repo.write('new.txt', 'n\n');
    repo.write('keep.txt', 'unrelated new file\n');
    const res = await request(app).post('/api/sessions/S/git/discard').send({ terminalId: 't1', paths: ['a.txt', 'new.txt'] });
    expect(res.status).toBe(200);
    expect(res.body.discarded.map((d: any) => d.path)).toEqual(['a.txt', 'new.txt']);
    expect(res.body.errors).toEqual([]);
    expect(repo.read('a.txt')).toBe('one\ntwo\nthree\n');
    expect(repo.exists('new.txt')).toBe(false);
    expect(repo.status()).toBe(' M b.txt\n?? keep.txt\n');
    expect(repo.read('b.txt')).toBe('unrelated edit\n');
    expect(repo.read('keep.txt')).toBe('unrelated new file\n');
  });

  it('discard refuses a path outside the working directory', async () => {
    const { app } = appWith();
    const outside = `${repo.dir}.outside.txt`;
    fs.writeFileSync(outside, 'outside\n');
    try {
      repo.write('a.txt', 'edited\n');
      for (const bad of [`../${path.basename(outside)}`, outside, 'dir/../../x', '.', 'dir']) {
        const res = await request(app).post('/api/sessions/S/git/discard').send({ terminalId: 't1', paths: ['a.txt', bad] });
        expect(res.status, bad).toBe(403);
        expect(res.body.error).toBeTruthy();
      }
      expect((await request(app).post('/api/sessions/S/git/discard').send({ terminalId: 't1' })).status).toBe(400);
      expect((await request(app).post('/api/sessions/S/git/discard').send({ terminalId: 't1', paths: 'a.txt' })).status).toBe(400);
      expect(repo.read('a.txt')).toBe('edited\n');
      expect(fs.readFileSync(outside, 'utf8')).toBe('outside\n');
    } finally { fs.rmSync(outside, { force: true }); }
  });

  it('discard refuses a call with no credential and no browser headers', async () => {
    const { app, reg } = appWith('local');
    repo.write('a.txt', 'edited\n');
    const body = { terminalId: 't1', paths: ['a.txt'] };
    const res = await request(app).post('/api/sessions/S/git/discard').send(body);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('auth_required');
    expect(repo.read('a.txt')).toBe('edited\n');
    // A thread key cannot discard (or approve) work: it is the owner's review.
    const key = reg.mint({ kind: 'thread', terminalId: 't1' }).key;
    expect((await request(app).post('/api/sessions/S/git/discard').set('Authorization', `Bearer ${key}`).send(body)).status).toBe(403);
    expect((await request(app).post('/api/sessions/S/git/approve').set('Authorization', `Bearer ${key}`).send(body)).status).toBe(403);
    expect((await request(app).post('/api/sessions/S/git/approve').send(body)).status).toBe(401);
    expect((await request(app).post('/api/sessions/S/worktrees').send({})).status).toBe(401);
    expect(repo.read('a.txt')).toBe('edited\n');
    expect(repo.status()).toBe(' M a.txt\n');
    // The web page and the owner token pass.
    expect((await request(app).post('/api/sessions/S/git/approve').set('Origin', 'http://localhost:3456').send(body)).status).toBe(200);
    expect((await request(app).post('/api/sessions/S/git/discard').set('Authorization', `Bearer ${TOKEN}`).send(body)).status).toBe(200);
    expect(repo.read('a.txt')).toBe('one\ntwo\nthree\n');
  });

  it('POST /worktrees makes a worktree on a new branch and leaves the project as it was', async () => {
    const { app } = appWith();
    repo.write('a.txt', 'uncommitted\n');
    const before = repo.status();
    const res = await request(app).post('/api/sessions/S/worktrees').send({ name: 'Side quest' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: path.join(repo.dir, '.claude', 'worktrees', 'side-quest'), branch: 'dispatch/side-quest' });
    expect(gitIn(res.body.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('dispatch/side-quest');
    expect(repo.status()).toBe(before);
    expect(repo.git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    const list = await request(app).get('/api/sessions/S/worktrees');
    expect(list.body.worktrees).toEqual([{ path: res.body.path, branch: 'dispatch/side-quest', dirty: false, inUse: false }]);
  });

  it('POST /worktrees in a folder that is not a repository answers 400 with a clear error', async () => {
    const { app, db } = appWith();
    const plain = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(repo.dir), 'dispatch-w3g-plain-')));
    try {
      sessionsDb.create(db, { id: 'P', provider: 'claude-code', name: 'p', workingDir: plain });
      const res = await request(app).post('/api/sessions/P/worktrees').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not a git repository/i);
    } finally { fs.rmSync(plain, { recursive: true, force: true }); }
  });

  it('POST /worktrees/remove removes a clean worktree and refuses one with uncommitted work or a live thread', async () => {
    const { app, db } = appWith();
    const wt = (await request(app).post('/api/sessions/S/worktrees').send({ name: 'tmp' })).body;
    terminalsDb.create(db, { id: 'tw', sessionId: 'S', type: 'claude-code', label: 'in the worktree', workingDir: wt.path });
    const inUse = await request(app).post('/api/sessions/S/worktrees/remove').send({ path: wt.path });
    expect(inUse.status).toBe(409);
    expect(inUse.body.code).toBe('in_use');
    terminalsDb.archive(db, 'tw');
    fs.writeFileSync(path.join(wt.path, 'work.txt'), 'not committed\n');
    const dirty = await request(app).post('/api/sessions/S/worktrees/remove').send({ path: wt.path });
    expect(dirty.status).toBe(409);
    expect(dirty.body.code).toBe('dirty');
    expect(fs.readFileSync(path.join(wt.path, 'work.txt'), 'utf8')).toBe('not committed\n');
    fs.rmSync(path.join(wt.path, 'work.txt'));
    expect((await request(app).post('/api/sessions/S/worktrees/remove').send({ path: repo.dir })).status).toBe(403);
    const ok = await request(app).post('/api/sessions/S/worktrees/remove').send({ path: wt.path });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ removed: true, path: wt.path, branch: 'dispatch/tmp' });
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(repo.git('branch', '--list', 'dispatch/tmp')).toContain('dispatch/tmp');
  });
});
