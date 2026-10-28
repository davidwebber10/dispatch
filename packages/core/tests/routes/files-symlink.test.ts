// SEC-12: a symlink inside the project must not lead a file route to a file outside it.
// Each test works in its own nested temporary folder: <tmp>/files-symlink-XXXX/{project,outside}.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';
import * as sessionsDb from '../../src/db/sessions.js';
import { insideRealRoot } from '../../src/files/confine.js';

describe('file routes refuse symlinks that lead out of the project', () => {
  let base: string;
  let project: string;
  let outside: string;
  let app: any;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'files-symlink-'));
    project = path.join(base, 'project');
    outside = path.join(base, 'outside');
    fs.mkdirSync(project);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP-SECRET');
    fs.writeFileSync(path.join(outside, 'key.png'), 'PRIVATE-KEY-BYTES');
    fs.writeFileSync(path.join(project, 'inside.txt'), 'fine');
    fs.writeFileSync(path.join(project, 'inside.png'), 'png-bytes');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(project, 'notes.txt'));
    fs.symlinkSync(path.join(outside, 'key.png'), path.join(project, 'x.png'));
    fs.symlinkSync(outside, path.join(project, 'linkdir'));
    fs.symlinkSync(path.join(outside, 'not-yet.txt'), path.join(project, 'dangling.txt'));
    const db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'test', workingDir: project });
    app = createApp({ db, skipPty: true });
  });
  afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

  it('read: a file symlink and a folder symlink are refused; a plain file still reads', async () => {
    expect((await request(app).get('/api/sessions/s1/files/read?path=notes.txt')).status).toBe(403);
    expect((await request(app).get('/api/sessions/s1/files/read?path=linkdir/secret.txt')).status).toBe(403);
    const ok = await request(app).get('/api/sessions/s1/files/read?path=inside.txt');
    expect(ok.status).toBe(200);
    expect(ok.body.content).toBe('fine');
  });

  it('read: an absolute path stays the documented escape hatch', async () => {
    const res = await request(app).get(`/api/sessions/s1/files/read?path=${encodeURIComponent(path.join(outside, 'secret.txt'))}`);
    expect(res.status).toBe(200);
  });

  it('list: a symlinked folder is not listed', async () => {
    expect((await request(app).get('/api/sessions/s1/files?path=linkdir')).status).toBe(403);
    expect((await request(app).get('/api/sessions/s1/files?path=.')).status).toBe(200);
  });

  it('image: a symlink to a file outside is refused; a plain image is served', async () => {
    expect((await request(app).get('/api/sessions/s1/files/image?path=x.png')).status).toBe(403);
    const ok = await request(app).get('/api/sessions/s1/files/image?path=inside.png');
    expect(ok.status).toBe(200);
  });

  it('download: a symlink to a file outside is refused; a plain file downloads', async () => {
    expect((await request(app).get('/api/sessions/s1/files/download?path=notes.txt')).status).toBe(403);
    expect((await request(app).get('/api/sessions/s1/files/download?path=linkdir/secret.txt')).status).toBe(403);
    expect((await request(app).get('/api/sessions/s1/files/download?path=inside.txt')).status).toBe(200);
  });

  it('write: through a file symlink, a folder symlink or a dangling symlink is refused; a new file works', async () => {
    for (const p of ['notes.txt', 'linkdir/new.txt', 'dangling.txt']) {
      const res = await request(app).put(`/api/sessions/s1/files/write?path=${p}`).send({ content: 'pwned' });
      expect(res.status, p).toBe(403);
    }
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('TOP-SECRET');
    expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false);
    expect(fs.existsSync(path.join(outside, 'not-yet.txt'))).toBe(false);
    const ok = await request(app).put('/api/sessions/s1/files/write?path=sub-new.txt').send({ content: 'hi' });
    expect(ok.status).toBe(200);
    expect(fs.readFileSync(path.join(project, 'sub-new.txt'), 'utf8')).toBe('hi');
  });

  it('mkdir: inside a folder symlink is refused; a new nested folder works', async () => {
    expect((await request(app).post('/api/sessions/s1/files/mkdir?path=linkdir/made')).status).toBe(403);
    expect(fs.existsSync(path.join(outside, 'made'))).toBe(false);
    expect((await request(app).post('/api/sessions/s1/files/mkdir?path=a/b/c')).status).toBe(200);
  });

  it('upload: into a folder symlink, or over a file symlink, is refused; a plain upload works', async () => {
    const into = await request(app).post('/api/sessions/s1/files/upload?path=linkdir').attach('file', Buffer.from('x'), 'up.txt');
    expect(into.status).toBe(403);
    expect(fs.existsSync(path.join(outside, 'up.txt'))).toBe(false);
    const over = await request(app).post('/api/sessions/s1/files/upload?path=.').attach('file', Buffer.from('x'), 'notes.txt');
    expect(over.status).toBe(403);
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('TOP-SECRET');
    const ok = await request(app).post('/api/sessions/s1/files/upload?path=.').attach('file', Buffer.from('x'), 'plain.txt');
    expect(ok.status).toBe(200);
  });

  it('inbox: a .dispatch symlink to a folder outside is refused', async () => {
    fs.symlinkSync(outside, path.join(project, '.dispatch'));
    const res = await request(app).post('/api/sessions/s1/files/inbox').attach('file', Buffer.from('x'), 'a.txt');
    expect(res.status).toBe(403);
    expect(fs.existsSync(path.join(outside, 'inbox'))).toBe(false);
  });

  it('a link that stays inside the project keeps working (workspace link, alias, nested folder link)', async () => {
    fs.mkdirSync(path.join(project, 'packages/a'), { recursive: true });
    fs.writeFileSync(path.join(project, 'packages/a/index.txt'), 'shared');
    fs.mkdirSync(path.join(project, 'node_modules/@x'), { recursive: true });
    fs.symlinkSync('../../packages/a', path.join(project, 'node_modules/@x/a'));
    fs.symlinkSync(path.join(project, 'inside.png'), path.join(project, 'alias.png'));
    expect((await request(app).get('/api/sessions/s1/files/read?path=node_modules/@x/a/index.txt')).body.content).toBe('shared');
    expect((await request(app).put('/api/sessions/s1/files/write?path=node_modules/@x/a/new.txt').send({ content: 'ok' })).status).toBe(200);
    expect(fs.readFileSync(path.join(project, 'packages/a/new.txt'), 'utf8')).toBe('ok');
    expect((await request(app).get('/api/sessions/s1/files/image?path=alias.png')).status).toBe(200);
    expect((await request(app).get('/api/sessions/s1/files?path=node_modules/@x/a')).status).toBe(200);
  });

  it('a dependency link out of a workspace package into another node_modules keeps working; a link into a plain folder does not', async () => {
    // repo/node_modules/.pnpm/react/node_modules/react  <-  project/node_modules/react   (project = repo/packages/web)
    const dep = path.join(base, 'node_modules/.pnpm/react@1/node_modules/react');
    fs.mkdirSync(dep, { recursive: true });
    fs.writeFileSync(path.join(dep, 'index.js'), 'module.exports = 1');
    fs.mkdirSync(path.join(project, 'node_modules'), { recursive: true });
    fs.symlinkSync(dep, path.join(project, 'node_modules/react'));
    fs.symlinkSync(outside, path.join(project, 'node_modules/evil'));
    expect((await request(app).get('/api/sessions/s1/files/read?path=node_modules/react/index.js')).body.content).toBe('module.exports = 1');
    expect((await request(app).get('/api/sessions/s1/files/read?path=node_modules/evil/secret.txt')).status).toBe(403);
    // A new node_modules folder named at the far end of a link out of the project is not a dependency link.
    expect((await request(app).put('/api/sessions/s1/files/write?path=node_modules/evil/node_modules/foo/index.js').send({ content: 'x' })).status).toBe(403);
    expect(fs.existsSync(path.join(outside, 'node_modules'))).toBe(false);
  });

  it('DISPATCH_FILE_ROOTS lets a link lead into a named folder outside the project; "/" turns the check off', async () => {
    const prev = process.env.DISPATCH_FILE_ROOTS;
    try {
      process.env.DISPATCH_FILE_ROOTS = outside;
      expect((await request(app).get('/api/sessions/s1/files/read?path=notes.txt')).status).toBe(200);
      expect((await request(app).get('/api/sessions/s1/files/read?path=linkdir/secret.txt')).status).toBe(200);
      // A folder that is not listed is still refused.
      const other = path.join(base, 'other');
      fs.mkdirSync(other);
      fs.writeFileSync(path.join(other, 'o.txt'), 'o');
      fs.symlinkSync(other, path.join(project, 'otherlink'));
      expect((await request(app).get('/api/sessions/s1/files/read?path=otherlink/o.txt')).status).toBe(403);
      // Rename and delete agree with read and write on an allowed root.
      expect((await request(app).post('/api/sessions/s1/files/rename').send({ from: 'linkdir/secret.txt', to: 'linkdir/renamed.txt' })).status).toBe(200);
      expect((await request(app).delete('/api/sessions/s1/files?path=linkdir/renamed.txt')).status).toBe(200);
      process.env.DISPATCH_FILE_ROOTS = '/';
      expect((await request(app).get('/api/sessions/s1/files/read?path=otherlink/o.txt')).status).toBe(200);
    } finally {
      if (prev === undefined) delete process.env.DISPATCH_FILE_ROOTS; else process.env.DISPATCH_FILE_ROOTS = prev;
    }
  });

  it('insideRealRoot: new files check the parent, the root itself passes', () => {
    expect(insideRealRoot(project, path.join(project, 'brand', 'new.txt'))).toBe(true);
    expect(insideRealRoot(project, project)).toBe(true);
    expect(insideRealRoot(project, path.join(project, 'linkdir', 'new.txt'))).toBe(false);
    expect(insideRealRoot(project, outside)).toBe(false);
  });
});
