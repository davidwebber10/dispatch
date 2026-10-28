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

  it('insideRealRoot: new files check the parent, the root itself passes', () => {
    expect(insideRealRoot(project, path.join(project, 'brand', 'new.txt'))).toBe(true);
    expect(insideRealRoot(project, project)).toBe(true);
    expect(insideRealRoot(project, path.join(project, 'linkdir', 'new.txt'))).toBe(false);
    expect(insideRealRoot(project, outside)).toBe(false);
  });
});
