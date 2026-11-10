import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import http from 'http';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
// Own upload folder: this file empties and counts it, and must not touch the live daemon's or another test file's.
vi.hoisted(() => { process.env.DISPATCH_UPLOAD_DIR = `${process.env.TMPDIR || '/tmp'}/dispatch-upload-test-${process.pid}`; });
import { PassThrough } from 'stream';
import { clientMessage } from '../http/client-message.js';
import { createFilesRouter, uploadStorage, UPLOAD_TMP_DIR as TMP_UPLOAD_DIR } from './files.js';

afterAll(() => { fs.rmSync(TMP_UPLOAD_DIR, { recursive: true, force: true }); });

function makeApp(workingDir: string) {
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'test', workingDir });
  const app = express();
  app.use(express.json());
  app.use('/api/sessions/:id/files', createFilesRouter(db));
  return app;
}

describe('upload tmp dir resilience', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-files-test-'));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  // macOS deletes idle /tmp entries after ~3 days, so the multer temp dir created
  // once at daemon startup can vanish mid-uptime. Every upload then fails with
  // ENOENT until the daemon restarts. The routes must recreate it per request.
  it('inbox upload succeeds after the tmp dir was deleted', async () => {
    // Build the router FIRST: the daemon constructs it once at startup, and the
    // tmp dir disappears later, mid-uptime.
    const app = makeApp(workDir);
    fs.rmSync(TMP_UPLOAD_DIR, { recursive: true, force: true });
    const res = await request(app)
      .post('/api/sessions/s1/files/inbox')
      .attach('file', Buffer.from('hello'), { filename: 'note.txt', contentType: 'text/plain' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(fs.readFileSync(path.join(workDir, res.body.path), 'utf8')).toBe('hello');
  });

  it('files upload succeeds after the tmp dir was deleted', async () => {
    const app = makeApp(workDir);
    fs.rmSync(TMP_UPLOAD_DIR, { recursive: true, force: true });
    const res = await request(app)
      .post('/api/sessions/s1/files/upload')
      .attach('file', Buffer.from('world'), { filename: 'up.txt', contentType: 'text/plain' });
    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(workDir, 'up.txt'), 'utf8')).toBe('world');
  });
});

describe('path safety and read limits', () => {
  let workDir: string;
  beforeEach(() => { workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-files-sec-')); });
  afterEach(() => { fs.rmSync(workDir, { recursive: true, force: true }); });

  it('delete refuses the project root and leaves it intact', async () => {
    fs.writeFileSync(path.join(workDir, 'keep.txt'), 'x');
    for (const p of ['.', './', 'sub/..']) {
      const res = await request(makeApp(workDir)).delete('/api/sessions/s1/files').query({ path: p });
      expect(res.status).toBe(400);
    }
    expect(fs.existsSync(path.join(workDir, 'keep.txt'))).toBe(true);
  });

  it('delete refuses an empty path and a path outside the project', async () => {
    const app = makeApp(workDir);
    expect((await request(app).delete('/api/sessions/s1/files').query({ path: '' })).status).toBe(400);
    expect((await request(app).delete('/api/sessions/s1/files').query({ path: '../x' })).status).toBe(403);
    expect(fs.existsSync(workDir)).toBe(true);
  });

  it('delete still removes a file and a nested directory', async () => {
    fs.mkdirSync(path.join(workDir, 'd/e'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'f.txt'), 'x');
    const app = makeApp(workDir);
    expect((await request(app).delete('/api/sessions/s1/files').query({ path: 'f.txt' })).status).toBe(200);
    expect((await request(app).delete('/api/sessions/s1/files').query({ path: 'd' })).status).toBe(200);
    expect(fs.existsSync(path.join(workDir, 'd'))).toBe(false);
  });

  it('rename refuses the project root as source or target', async () => {
    fs.writeFileSync(path.join(workDir, 'a.txt'), 'x');
    const app = makeApp(workDir);
    expect((await request(app).post('/api/sessions/s1/files/rename').send({ from: '.', to: 'moved' })).status).toBe(400);
    expect((await request(app).post('/api/sessions/s1/files/rename').send({ from: 'a.txt', to: '.' })).status).toBe(400);
    expect(fs.existsSync(path.join(workDir, 'a.txt'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('read refuses a FIFO without hanging', async () => {
    const fifo = path.join(workDir, 'pipe');
    execFileSync('mkfifo', [fifo]);
    const res = await request(makeApp(workDir)).get('/api/sessions/s1/files/read').query({ path: 'pipe' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/regular file/);
  });

  it('read refuses a device file and a directory', async () => {
    const app = makeApp(workDir);
    const dev = await request(app).get('/api/sessions/s1/files/read').query({ path: '/dev/zero' });
    expect(dev.status).toBe(400);
    const dir = await request(app).get('/api/sessions/s1/files/read').query({ path: '.' });
    expect(dir.status).toBe(400);
  });

  it('read refuses a file over the size cap, and reads a normal one', async () => {
    fs.writeFileSync(path.join(workDir, 'big.txt'), Buffer.alloc(5 * 1024 * 1024 + 1, 'a'));
    fs.writeFileSync(path.join(workDir, 'ok.txt'), 'hello');
    const app = makeApp(workDir);
    expect((await request(app).get('/api/sessions/s1/files/read').query({ path: 'big.txt' })).status).toBe(413);
    const ok = await request(app).get('/api/sessions/s1/files/read').query({ path: 'ok.txt' });
    expect(ok.body.content).toBe('hello');
  });

  it('an array-valued path is a 400, not a 500', async () => {
    const app = makeApp(workDir);
    for (const url of ['/api/sessions/s1/files?path[]=x', '/api/sessions/s1/files/read?path[]=x', '/api/sessions/s1/files/mkdir?path[]=x']) {
      const res = url.includes('mkdir') ? await request(app).post(url) : await request(app).get(url);
      expect(res.status).toBe(400);
    }
  });
});

describe('read cannot follow a symlink out of the project', () => {
  let workDir: string;
  let outside: string;
  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-files-rd-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-files-rdout-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
    fs.writeFileSync(path.join(workDir, 'ok.txt'), 'fine');
    fs.mkdirSync(path.join(workDir, 'docs'));
    fs.symlinkSync(outside, path.join(workDir, 'link'));
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(workDir, 'leaf.txt'));
  });
  afterEach(() => { fs.rmSync(workDir, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const read = (app: express.Express, p: string) => request(app).get('/api/sessions/s1/files/read').query({ path: p });

  it('a relative path through a linked folder or to a linked file is refused', async () => {
    const app = makeApp(workDir);
    expect((await read(app, 'link/secret.txt')).status).toBe(403);
    expect((await read(app, 'leaf.txt')).status).toBe(403);
    expect((await read(app, 'docs/../../secret.txt')).status).toBe(403);
  });
  it('an absolute path inside the project that goes through a symlink out of it is refused too', async () => {
    const app = makeApp(workDir);
    expect((await read(app, path.join(workDir, 'link', 'secret.txt'))).status).toBe(403);
    expect((await read(app, path.join(workDir, 'leaf.txt'))).status).toBe(403);
    expect((await read(app, path.join(workDir, 'docs', '..', 'link', 'secret.txt'))).status).toBe(403);
  });
  it('a file swapped for a symlink out of the project after the check is never read', async () => {
    fs.writeFileSync(path.join(workDir, 'swap.txt'), 'inside');
    const realOpen = fs.promises.open.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(((p: any, ...rest: any[]) => {
      // the check has passed; now the file becomes a link to the outside file
      fs.rmSync(path.join(workDir, 'swap.txt'));
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(workDir, 'swap.txt'));
      return (realOpen as any)(p, ...rest);
    }) as any);
    try {
      const app = makeApp(workDir);
      const rel = await read(app, 'swap.txt');
      expect(rel.status).toBe(403);
      expect(JSON.stringify(rel.body)).not.toContain('top secret');
      fs.rmSync(path.join(workDir, 'swap.txt'));
      fs.writeFileSync(path.join(workDir, 'swap.txt'), 'inside');
      const abs = await read(app, path.join(workDir, 'swap.txt'));
      expect(abs.status).toBe(403);
      expect(JSON.stringify(abs.body)).not.toContain('top secret');
    } finally { spy.mockRestore(); }
  });
  it('sniff=1: reads only the start of the file and says whether it is binary (a NUL byte); no sniff changes nothing', async () => {
    fs.writeFileSync(path.join(workDir, 'model.pt'), Buffer.from([0x80, 0x02, 0x00, 0x01, 0x7a]));
    const app = makeApp(workDir);
    const sniffed = await request(app).get('/api/sessions/s1/files/read').query({ path: 'model.pt', sniff: '1' });
    expect(sniffed.body).toEqual({ content: '', path: 'model.pt', binary: true });
    const text = await request(app).get('/api/sessions/s1/files/read').query({ path: 'ok.txt', sniff: '1' });
    expect(text.body).toEqual({ content: '', path: 'ok.txt', binary: false });
    const plain = await request(app).get('/api/sessions/s1/files/read').query({ path: 'model.pt' });
    expect(plain.body.binary).toBeUndefined();
    expect(plain.body.content.length).toBeGreaterThan(0);
  });
  it('a real file inside the project reads, by a relative or an absolute path', async () => {
    const app = makeApp(workDir);
    expect((await read(app, 'ok.txt')).body.content).toBe('fine');
    expect((await read(app, path.join(workDir, 'ok.txt'))).body.content).toBe('fine');
  });
  it('an absolute path outside the project still reads (the View button for an agent that edits another repo)', async () => {
    const res = await read(makeApp(workDir), path.join(outside, 'secret.txt'));
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('top secret');
  });
});

describe('a swap between the check and the open never leaks an outside file', () => {
  let workDir: string;
  let outside: string;
  const get = (app: express.Express, route: string, p: string) => request(app).get(`/api/sessions/s1/files/${route}`).query({ path: p }).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  const bodyText = (r: request.Response) => (Buffer.isBuffer(r.body) ? r.body.toString('utf8') : JSON.stringify(r.body));
  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-files-sw-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-files-swout-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
    fs.mkdirSync(path.join(outside, 'docs'));
    fs.writeFileSync(path.join(outside, 'docs', 'a.py'), 'top secret');
    fs.writeFileSync(path.join(workDir, 'archive.zip'), 'inside zip');
    fs.writeFileSync(path.join(workDir, 'pic.png'), 'inside png');
    fs.mkdirSync(path.join(workDir, 'docs'));
    fs.writeFileSync(path.join(workDir, 'docs', 'a.py'), 'inside');
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(workDir, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });

  /** Replace `rel` with a symlink to `target` (and back). */
  const swapIn = (rel: string, target: string) => { const p = path.join(workDir, rel); fs.renameSync(p, `${p}.bak`); fs.symlinkSync(target, p); };
  const swapOut = (rel: string) => { const p = path.join(workDir, rel); fs.rmSync(p, { force: true }); fs.renameSync(`${p}.bak`, p); };

  it('a download whose file becomes a link to an outside file is refused', async () => {
    const realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(((p: any, ...rest: any[]) => { swapIn('archive.zip', path.join(outside, 'secret.txt')); return (realOpen as any)(p, ...rest); }) as any);
    const res = await get(makeApp(workDir), 'download', 'archive.zip');
    expect(res.status).toBe(403);
    expect(bodyText(res)).not.toContain('top secret');
  });
  it('an image whose file becomes a link to an outside file is refused', async () => {
    const realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(((p: any, ...rest: any[]) => { swapIn('pic.png', path.join(outside, 'secret.txt')); return (realOpen as any)(p, ...rest); }) as any);
    const res = await get(makeApp(workDir), 'image', 'pic.png');
    expect(res.status).toBe(403);
    expect(bodyText(res)).not.toContain('top secret');
  });
  it('a download and a read of an unchanged file still work', async () => {
    const app = makeApp(workDir);
    const dl = await get(app, 'download', 'archive.zip');
    expect(dl.status).toBe(200);
    expect(bodyText(dl)).toBe('inside zip');
    expect(dl.headers['content-disposition']).toContain('archive.zip');
    expect(JSON.parse(bodyText(await get(app, 'read', 'docs/a.py'))).content).toBe('inside');
  });
  it.each(['read', 'download'])('%s: a parent folder swapped for a link to an outside folder after the realpath, and put back after the open, is refused', async (route) => {
    const realRealpath = fs.promises.realpath.bind(fs.promises);
    const realOpen = fs.promises.open.bind(fs.promises);
    let swapped = false;
    vi.spyOn(fs.promises, 'realpath').mockImplementation((async (p: any, ...rest: any[]) => {
      const r = await (realRealpath as any)(p, ...rest);
      if (!swapped && String(r).endsWith(path.join('docs', 'a.py'))) { swapped = true; swapIn('docs', path.join(outside, 'docs')); }
      return r;
    }) as any);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
      const fh = await (realOpen as any)(p, ...rest);
      if (swapped) { swapOut('docs'); swapped = false; }
      return fh;
    }) as any);
    const res = await get(makeApp(workDir), route, 'docs/a.py');
    expect(res.status).toBe(403);
    expect(bodyText(res)).not.toContain('top secret');
  });
  it.each(['read', 'download'])('%s: a parent folder swapped just before the open and put back after it is refused', async (route) => {
    const realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
      swapIn('docs', path.join(outside, 'docs'));
      const fh = await (realOpen as any)(p, ...rest);
      swapOut('docs');
      return fh;
    }) as any);
    const res = await get(makeApp(workDir), route, 'docs/a.py');
    expect(res.status).toBe(403);
    expect(bodyText(res)).not.toContain('top secret');
  });
});

describe('links that are allowed still read and download', () => {
  let base: string;
  let project: string;
  const saved = process.env.DISPATCH_FILE_ROOTS;
  const bytes = (route: string, app: express.Express, p: string) => request(app).get(`/api/sessions/s1/files/${route}`).query({ path: p }).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-files-ok-')));
    project = path.join(base, 'repo', 'packages', 'web');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    fs.writeFileSync(path.join(project, 'src', 'real.txt'), 'real file');
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.DISPATCH_FILE_ROOTS; else process.env.DISPATCH_FILE_ROOTS = saved;
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('a link that stays inside the project (a file link and a folder link) reads and downloads', async () => {
    fs.symlinkSync(path.join(project, 'src', 'real.txt'), path.join(project, 'alias.txt'));
    fs.symlinkSync(path.join(project, 'src'), path.join(project, 'srclink'));
    const app = makeApp(project);
    for (const p of ['alias.txt', 'srclink/real.txt', path.join(project, 'alias.txt')]) {
      expect(JSON.parse((await bytes('read', app, p)).body.toString()).content).toBe('real file');
    }
    const dl = await bytes('download', app, 'srclink/real.txt');
    expect(dl.status).toBe(200);
    expect(dl.body.toString()).toBe('real file');
  });
  it('a pnpm node_modules link that leads outside the project, into another node_modules folder, reads and downloads', async () => {
    const store = path.join(base, 'repo', 'node_modules', '.pnpm', 'pkg@1.0.0', 'node_modules', 'pkg');
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, 'index.js'), 'module.exports = 1;');
    fs.mkdirSync(path.join(project, 'node_modules'));
    fs.symlinkSync(store, path.join(project, 'node_modules', 'pkg'));
    const app = makeApp(project);
    expect(JSON.parse((await bytes('read', app, 'node_modules/pkg/index.js')).body.toString()).content).toBe('module.exports = 1;');
    const dl = await bytes('download', app, 'node_modules/pkg/index.js');
    expect(dl.status).toBe(200);
    expect(dl.body.toString()).toBe('module.exports = 1;');
  });
  it('a link into a DISPATCH_FILE_ROOTS folder reads and downloads; without it, the same link is refused', async () => {
    const shared = path.join(base, 'shared');
    fs.mkdirSync(shared);
    fs.writeFileSync(path.join(shared, 'a.txt'), 'shared file');
    fs.symlinkSync(shared, path.join(project, 'shared'));
    const app = makeApp(project);
    delete process.env.DISPATCH_FILE_ROOTS;
    expect((await bytes('read', app, 'shared/a.txt')).status).toBe(403);
    expect((await bytes('download', app, 'shared/a.txt')).status).toBe(403);
    process.env.DISPATCH_FILE_ROOTS = shared;
    expect(JSON.parse((await bytes('read', app, 'shared/a.txt')).body.toString()).content).toBe('shared file');
    const dl = await bytes('download', app, 'shared/a.txt');
    expect(dl.status).toBe(200);
    expect(dl.body.toString()).toBe('shared file');
  });
  it('a project reached through a linked root (such as /tmp on macOS) reads and downloads', async () => {
    const linkRoot = path.join(base, 'linkroot');
    fs.symlinkSync(path.join(base, 'repo'), linkRoot);
    const app = makeApp(path.join(linkRoot, 'packages', 'web'));
    expect(JSON.parse((await bytes('read', app, 'src/real.txt')).body.toString()).content).toBe('real file');
    expect(JSON.parse((await bytes('read', app, path.join(linkRoot, 'packages', 'web', 'src', 'real.txt'))).body.toString()).content).toBe('real file');
    const dl = await bytes('download', app, 'src/real.txt');
    expect(dl.status).toBe(200);
    expect(dl.body.toString()).toBe('real file');
  });
});

describe('symlinked folders cannot lead delete or rename outside the project', () => {
  let workDir: string;
  let outside: string;
  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-files-ln-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-files-out-'));
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'x');
    fs.symlinkSync(outside, path.join(workDir, 'link'));
  });
  afterEach(() => { fs.rmSync(workDir, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });

  it('delete through a symlinked folder is refused and the target is untouched', async () => {
    const res = await request(makeApp(workDir)).delete('/api/sessions/s1/files').query({ path: 'link/keep.txt' });
    expect(res.status).toBe(403);
    expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true);
  });

  it('rename into or out of a symlinked folder is refused', async () => {
    fs.writeFileSync(path.join(workDir, 'a.txt'), 'x');
    const app = makeApp(workDir);
    expect((await request(app).post('/api/sessions/s1/files/rename').send({ from: 'a.txt', to: 'link/a.txt' })).status).toBe(403);
    expect((await request(app).post('/api/sessions/s1/files/rename').send({ from: 'link/keep.txt', to: 'k.txt' })).status).toBe(403);
    expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true);
  });

  it('deleting the symlink itself is allowed and leaves the target', async () => {
    const res = await request(makeApp(workDir)).delete('/api/sessions/s1/files').query({ path: 'link' });
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true);
  });
});

describe('clientMessage', () => {
  it('keeps the text of our own errors, and never passes on a system or subprocess error', () => {
    expect(clientMessage(new Error('Cannot rename the project folder'))).toBe('Cannot rename the project folder');
    expect(clientMessage(Object.assign(new Error("ENOENT: no such file or directory, open '/Users/x/y'"), { code: 'ENOENT' }))).toBe('File or folder not found');
    // execFile fails with a numeric exit code and a message that holds the command line and the path.
    const sub = Object.assign(new Error('Command failed: /usr/bin/open -R /Users/x/y\nThe file /Users/x/y does not exist.'), { code: 1, cmd: '/usr/bin/open -R /Users/x/y' });
    expect(clientMessage(sub)).toBe('The operation failed');
    expect(clientMessage(Object.assign(new Error('spawn open ENOENT /Users/x'), { syscall: 'spawn open', errno: -2 }))).toBe('The operation failed');
  });
});

describe('upload limits and temp folder', () => {
  let workDir: string;
  beforeEach(() => { workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-files-up-')); });
  afterEach(() => { fs.rmSync(workDir, { recursive: true, force: true }); });

  it('the temp folder is private to the owner', async () => {
    const app = makeApp(workDir);
    fs.rmSync(TMP_UPLOAD_DIR, { recursive: true, force: true });
    await request(app).post('/api/sessions/s1/files/upload').attach('file', Buffer.from('a'), { filename: 'a.txt', contentType: 'text/plain' });
    expect(fs.statSync(TMP_UPLOAD_DIR).mode & 0o777).toBe(0o700);
  });

  it('the 413 for an upload over the limit is the status and a message, with no stack or path', async () => {
    for (const route of ['upload', 'inbox']) {
      const res = await request(makeApp(workDir))
        .post(`/api/sessions/s1/files/${route}`)
        .attach('file', Buffer.alloc(101 * 1024 * 1024), { filename: 'big.bin', contentType: 'application/octet-stream' });
      expect(res.status).toBe(413);
      expect(Object.keys(res.body)).toEqual(['error']);
      expect(res.text).not.toMatch(/node_modules|\bat \S+ \(|\.ts:\d+|\/Users\/|\/var\/|\/tmp\/|dispatch-upload/);
    }
  });

  it('a failed upload save says what went wrong without the server path', async () => {
    const app = makeApp(workDir);
    // The target folder does not exist, so the copy fails: the system message names both paths.
    const res = await request(app)
      .post('/api/sessions/s1/files/upload?path=no-such-folder')
      .attach('file', Buffer.from('hi'), { filename: 'a.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body)).toEqual(['error']);
    expect(res.body.error).not.toContain(workDir);
    expect(res.body.error).not.toContain(TMP_UPLOAD_DIR);
    expect(res.body.error).not.toMatch(/ENOENT|copyfile/i);
    expect(fs.readdirSync(TMP_UPLOAD_DIR)).toEqual([]); // and the temp file is gone
  });

  it('upload over the limit is a 413 and leaves no temp file', async () => {
    const before = fs.existsSync(TMP_UPLOAD_DIR) ? fs.readdirSync(TMP_UPLOAD_DIR).length : 0;
    const res = await request(makeApp(workDir))
      .post('/api/sessions/s1/files/upload')
      .attach('file', Buffer.alloc(101 * 1024 * 1024), { filename: 'big.bin', contentType: 'application/octet-stream' });
    expect(res.status).toBe(413);
    expect(fs.existsSync(path.join(workDir, 'big.bin'))).toBe(false);
    expect(fs.readdirSync(TMP_UPLOAD_DIR).length).toBe(before);
  });

  it('a client that drops the connection mid-upload leaves no temp file', async () => {
    const app = makeApp(workDir);
    const server = await new Promise<import('http').Server>((resolve) => { const sv = app.listen(0, () => resolve(sv)); });
    try {
      const { port } = server.address() as import('net').AddressInfo;
      const boundary = 'xXxBoundary';
      await new Promise<void>((resolve) => {
        const req = http.request({ port, method: 'POST', path: '/api/sessions/s1/files/upload', headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(10 * 1024 * 1024) } });
        req.on('error', () => resolve());
        req.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`);
        req.write(Buffer.alloc(256 * 1024, 1));
        // Let the daemon create the temp file, then drop the socket before the body is complete.
        setTimeout(() => { req.destroy(); resolve(); }, 300);
      });
      await new Promise((r) => setTimeout(r, 500));
      expect(fs.readdirSync(TMP_UPLOAD_DIR)).toEqual([]);
    } finally { server.close(); }
  });

  it.skipIf(process.platform === 'win32' || !fs.existsSync('/dev/fd'))('a dropped upload releases its file handle, on /upload and /inbox', async () => {
    const app = makeApp(workDir);
    const server = await new Promise<import('http').Server>((resolve) => { const sv = app.listen(0, () => resolve(sv)); });
    const openFds = () => fs.readdirSync('/dev/fd').length;
    const drop = (route: string) => new Promise<void>((resolve) => {
      const { port } = server.address() as import('net').AddressInfo;
      const boundary = 'xXxBoundary';
      const req = http.request({ port, method: 'POST', path: `/api/sessions/s1/files/${route}`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(10 * 1024 * 1024) } });
      req.on('error', () => resolve());
      req.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`);
      req.write(Buffer.alloc(256 * 1024, 1));
      setTimeout(() => { req.destroy(); resolve(); }, 300);
    });
    try {
      await drop('upload'); await drop('inbox'); // warm up: sockets and lazy handles settle
      await new Promise((r) => setTimeout(r, 500));
      const before = openFds();
      for (let i = 0; i < 3; i++) { await drop('upload'); await drop('inbox'); }
      await new Promise((r) => setTimeout(r, 800));
      expect(openFds()).toBeLessThanOrEqual(before);
      expect(fs.readdirSync(TMP_UPLOAD_DIR)).toEqual([]);
    } finally { server.close(); }
  });

  it('a dropped /upload never touches an existing destination file, and /inbox gets no attachment', async () => {
    fs.writeFileSync(path.join(workDir, 'a.bin'), 'ORIGINAL');
    const app = makeApp(workDir);
    const server = await new Promise<import('http').Server>((resolve) => { const sv = app.listen(0, () => resolve(sv)); });
    try {
      const { port } = server.address() as import('net').AddressInfo;
      const boundary = 'xXxBoundary';
      for (const route of ['upload?path=.', 'inbox']) {
        await new Promise<void>((resolve) => {
          const req = http.request({ port, method: 'POST', path: `/api/sessions/s1/files/${route}`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(10 * 1024 * 1024) } });
          req.on('error', () => resolve());
          req.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`);
          req.write(Buffer.alloc(64 * 1024, 1));
          setTimeout(() => { req.destroy(); resolve(); }, 200);
        });
      }
      await new Promise((r) => setTimeout(r, 2500)); // past the delayed second cleanup pass
      expect(fs.readFileSync(path.join(workDir, 'a.bin'), 'utf8')).toBe('ORIGINAL');
      expect(fs.existsSync(path.join(workDir, '.dispatch', 'inbox')) ? fs.readdirSync(path.join(workDir, '.dispatch', 'inbox')) : []).toEqual([]);
      expect(fs.readdirSync(TMP_UPLOAD_DIR)).toEqual([]);
    } finally { server.close(); }
  }, 15000);

  it('a refused upload destination deletes the temp file', async () => {
    const before = fs.readdirSync(TMP_UPLOAD_DIR).length;
    const res = await request(makeApp(workDir))
      .post('/api/sessions/s1/files/upload?path=../outside')
      .attach('file', Buffer.from('a'), { filename: 'a.txt', contentType: 'text/plain' });
    expect(res.status).toBe(403);
    expect(fs.readdirSync(TMP_UPLOAD_DIR).length).toBe(before);
  });
});

describe('upload storage engine', () => {
  const fileOf = (stream: PassThrough) => ({ stream, fieldname: 'file', originalname: 'a.bin', encoding: '7bit', mimetype: 'x' }) as any;
  const run = (stream: PassThrough) => new Promise<{ calls: Array<[Error | null, any]>; req: any }>((resolve) => {
    const calls: Array<[Error | null, any]> = [];
    const req: any = {};
    uploadStorage._handleFile(req, fileOf(stream), (err: any, info: any) => { calls.push([err ?? null, info]); });
    setTimeout(() => resolve({ calls, req }), 300);
  });

  it('a normal stream answers once with the temp path and size', async () => {
    const stream = new PassThrough();
    const p = run(stream);
    stream.end('hello');
    const { calls, req } = await p;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBeNull();
    expect(fs.readFileSync(calls[0][1].path, 'utf8')).toBe('hello');
    expect(calls[0][1].size).toBe(5);
    expect(fs.statSync(calls[0][1].path).mode & 0o777).toBe(0o600);
    fs.unlinkSync(req.uploadTmpPath);
  });

  it('an incoming-stream error answers once, closes the write stream and removes the temp file', async () => {
    const stream = new PassThrough();
    const p = run(stream);
    stream.write('part');
    setTimeout(() => stream.destroy(new Error('client went away')), 50);
    const { calls, req } = await p;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]?.message).toMatch(/went away/);
    expect(req.uploadStreams[0].destroyed).toBe(true);
    expect(fs.existsSync(req.uploadTmpPath)).toBe(false);
  });

  it('an error right after the stream ended still answers only once', async () => {
    const stream = new PassThrough();
    const p = run(stream);
    stream.end('data');
    setTimeout(() => (stream as any).emit('error', new Error('late')), 0);
    const { calls, req } = await p;
    expect(calls).toHaveLength(1);
    fs.rmSync(req.uploadTmpPath, { force: true });
  });

  it('cancelling while the file is still opening never reports success and leaves no file', async () => {
    const stream = new PassThrough();
    const calls: Array<[Error | null, any]> = [];
    const req: any = {};
    uploadStorage._handleFile(req, fileOf(stream), (err: any, info: any) => { calls.push([err ?? null, info]); });
    stream.end('complete body already parsed');
    req.uploadAbort();                       // cancel in the same tick: the open has not finished
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toHaveLength(1);
    expect(calls[0][0]?.message).toMatch(/cancel/i);
    expect(calls[0][1]).toBeUndefined();
    expect(fs.existsSync(req.uploadTmpPath)).toBe(false);
    expect(req.uploadStreams.every((x: any) => x.destroyed)).toBe(true);
  });

  it('a cancel after success changes nothing (the answer was already given)', async () => {
    const stream = new PassThrough();
    const p = run(stream);
    stream.end('x');
    const { calls, req } = await p;
    req.uploadAbort();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBeNull();
    fs.rmSync(req.uploadTmpPath, { force: true });
  });

  it('_removeFile with no path does not throw, and removes a real one', async () => {
    await new Promise<void>((resolve, reject) => uploadStorage._removeFile({} as any, {} as any, (e) => (e ? reject(e) : resolve())));
    const f = path.join(os.tmpdir(), `dispatch-rm-${process.pid}`);
    fs.writeFileSync(f, 'x');
    await new Promise<void>((resolve, reject) => uploadStorage._removeFile({} as any, { path: f } as any, (e) => (e ? reject(e) : resolve())));
    expect(fs.existsSync(f)).toBe(false);
  });
});

// W1-B: the read route never serves a file that holds credentials, to any caller.
describe('read refuses a path that holds credentials', () => {
  const OWNER_TOKEN = 'owner-access-token-for-the-files-test-0123456789';
  const REFUSAL = { error: 'This path holds credentials. Dispatch does not serve it.' };
  let base: string;
  let home: string;
  let dataDir: string;
  let workDir: string;
  let otherRepo: string;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-files-secret-')));
    home = path.join(base, 'home');
    dataDir = path.join(home, '.dispatch');
    workDir = path.join(home, 'Sites', 'project');
    otherRepo = path.join(home, 'Sites', 'other-repo');
    for (const d of [path.join(dataDir, 'keys'), path.join(dataDir, 'roles', 'reviewer'), path.join(home, '.ssh'), workDir, otherRepo]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'access-token'), 'the-owner-token\n');
    fs.writeFileSync(path.join(dataDir, 'dispatch.db'), 'sqlite bytes');
    fs.writeFileSync(path.join(dataDir, 'keys', 't1.h1'), 'dtk_thread_key');
    fs.writeFileSync(path.join(dataDir, 'roles', 'reviewer', 'role.md'), 'a role file');
    fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY');
    fs.writeFileSync(path.join(otherRepo, 'readme.md'), 'other repository');
    fs.writeFileSync(path.join(workDir, 'ok.txt'), 'fine');
  });
  afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

  /** The full principal chain: `via` is how the access gate let the request in; a Bearer token makes the owner. */
  async function secretApp(dir: string = workDir) {
    const { createPrincipalMiddleware } = await import('../auth/request-principal.js');
    const { createKeyScope } = await import('../auth/key-scope.js');
    const { KeyRegistry } = await import('../auth/principals.js');
    const { GATE_VIA } = await import('../auth/access-gate.js');
    const { defaultSecretRoots } = await import('../files/secret-paths.js');
    const db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'test', workingDir: dir });
    const app = express();
    app.use((req, _res, next) => { (req as any)[GATE_VIA] = 'local'; next(); });
    app.use(createPrincipalMiddleware({ registry: new KeyRegistry(), scope: createKeyScope(db), getToken: () => OWNER_TOKEN, via: 'test' }));
    app.use(express.json());
    app.use('/api/sessions/:id/files', createFilesRouter(db, { secretRoots: defaultSecretRoots(dataDir, home) }));
    return app;
  }
  const read = (app: express.Express, p: string, owner = false, extra: Record<string, string> = {}) => {
    const r = request(app).get('/api/sessions/s1/files/read').query({ path: p, ...extra });
    return owner ? r.set('Authorization', `Bearer ${OWNER_TOKEN}`) : r;
  };

  it('an absolute read of the access token answers 403', async () => {
    const app = await secretApp();
    for (const owner of [true, false]) {
      for (const p of [path.join(dataDir, 'access-token'), path.join(dataDir, 'dispatch.db'), path.join(dataDir, 'keys', 't1.h1'), path.join(home, '.ssh', 'id_ed25519')]) {
        const res = await read(app, p, owner);
        expect(res.status, `${owner ? 'owner' : 'no credential'} ${p}`).toBe(403);
        expect(res.body).toEqual(REFUSAL);
        expect(res.text).not.toContain('the-owner-token');
      }
    }
  });

  it('the binary probe (sniff=1) of a secret answers 403 too, and a missing file in a secret folder gives the same answer', async () => {
    const app = await secretApp();
    expect((await read(app, path.join(dataDir, 'access-token'), true, { sniff: '1' })).status).toBe(403);
    const missing = await read(app, path.join(home, '.ssh', 'no-such-key'));
    expect(missing.status).toBe(403);
    expect(missing.body).toEqual(REFUSAL);
  });

  it('a symbolic link that points at a secret answers 403', async () => {
    const app = await secretApp();
    // A link in another repository (the absolute-path escape hatch), a linked folder, and a link inside the project.
    fs.symlinkSync(path.join(dataDir, 'access-token'), path.join(otherRepo, 'notes.txt'));
    fs.symlinkSync(path.join(home, '.ssh'), path.join(otherRepo, 'docs'));
    fs.symlinkSync(path.join(dataDir, 'access-token'), path.join(workDir, 'leaf.txt'));
    for (const owner of [true, false]) {
      for (const p of [path.join(otherRepo, 'notes.txt'), path.join(otherRepo, 'docs', 'id_ed25519'), 'leaf.txt', path.join(workDir, 'leaf.txt')]) {
        const res = await read(app, p, owner);
        expect(res.status, `${owner ? 'owner' : 'no credential'} ${p}`).toBe(403);
        expect(res.text).not.toContain('the-owner-token');
        expect(res.text).not.toContain('PRIVATE KEY');
      }
    }
    expect((await read(app, path.join(otherRepo, 'notes.txt'))).body).toEqual(REFUSAL);
  });

  // Wave 1 integration (W1-B finding): /image and /download stay inside the project, but a project whose folder IS the
  // home folder (or ~/.dispatch) could still download a credential file through them.
  it('download and image refuse a credential file inside a project rooted at the home folder', async () => {
    const app = await secretApp(home);
    fs.writeFileSync(path.join(home, '.ssh', 'shot.png'), 'png bytes');
    for (const owner of [true, false]) {
      const auth = (r: request.Test) => (owner ? r.set('Authorization', `Bearer ${OWNER_TOKEN}`) : r);
      for (const p of ['.dispatch/access-token', '.ssh/id_ed25519', path.join(dataDir, 'dispatch.db')]) {
        const res = await auth(request(app).get('/api/sessions/s1/files/download').query({ path: p }));
        expect(res.status, `download ${owner ? 'owner' : 'no credential'} ${p}`).toBe(403);
        expect(res.body).toEqual(REFUSAL);
      }
      const img = await auth(request(app).get('/api/sessions/s1/files/image').query({ path: '.ssh/shot.png' }));
      expect(img.status).toBe(403);
      expect(img.body).toEqual(REFUSAL);
    }
    // An ordinary file in the same project still downloads.
    const ok = await request(app).get('/api/sessions/s1/files/download').query({ path: 'Sites/project/ok.txt' });
    expect(ok.status).toBe(200);
  });

  // v4.5.0 review, I4: the deny-list compared the text of the path. A second name of the same file went around it.
  it('a hard link to a secret answers 403 on read, download and image', async () => {
    const app = await secretApp(home);
    fs.linkSync(path.join(dataDir, 'access-token'), path.join(otherRepo, 'notes.txt'));
    fs.linkSync(path.join(home, '.ssh', 'id_ed25519'), path.join(otherRepo, 'key.txt'));
    fs.linkSync(path.join(dataDir, 'keys', 't1.h1'), path.join(workDir, 'shot.png'));
    for (const owner of [true, false]) {
      const auth = (r: request.Test) => (owner ? r.set('Authorization', `Bearer ${OWNER_TOKEN}`) : r);
      for (const p of [path.join(otherRepo, 'notes.txt'), path.join(otherRepo, 'key.txt'), 'Sites/other-repo/notes.txt']) {
        const res = await read(app, p, owner);
        expect(res.status, `read ${owner ? 'owner' : 'no credential'} ${p}`).toBe(403);
        expect(res.body).toEqual(REFUSAL);
        expect(res.text).not.toContain('the-owner-token');
        expect(res.text).not.toContain('PRIVATE KEY');
      }
      expect((await read(app, path.join(otherRepo, 'notes.txt'), owner, { sniff: '1' })).status).toBe(403);
      for (const p of ['Sites/other-repo/notes.txt', 'Sites/other-repo/key.txt']) {
        const res = await auth(request(app).get('/api/sessions/s1/files/download').query({ path: p }));
        expect(res.status, `download ${owner ? 'owner' : 'no credential'} ${p}`).toBe(403);
        expect(res.body).toEqual(REFUSAL);
      }
      const img = await auth(request(app).get('/api/sessions/s1/files/image').query({ path: 'Sites/project/shot.png' }));
      expect(img.status).toBe(403);
      expect(img.body).toEqual(REFUSAL);
    }
    // An ordinary file with two names (a pnpm store file) still reads and downloads.
    fs.linkSync(path.join(otherRepo, 'readme.md'), path.join(workDir, 'readme-link.md'));
    expect((await read(app, path.join(workDir, 'readme-link.md'))).body.content).toBe('other repository');
    expect((await request(app).get('/api/sessions/s1/files/download').query({ path: 'Sites/project/readme-link.md' })).status).toBe(200);
  });

  it.runIf(process.platform === 'darwin' && fs.existsSync('/System/Volumes/Data/private'))('the /System/Volumes/Data path of a secret answers 403', async () => {
    const alt = (p: string) => `/System/Volumes/Data${p}`;
    expect(fs.readFileSync(alt(path.join(dataDir, 'access-token')), 'utf8')).toBe('the-owner-token\n'); // the second path does reach the file
    const app = await secretApp();
    for (const owner of [true, false]) {
      for (const p of [path.join(dataDir, 'access-token'), path.join(dataDir, 'dispatch.db'), path.join(dataDir, 'keys', 't1.h1'), path.join(home, '.ssh', 'id_ed25519')]) {
        const res = await read(app, alt(p), owner);
        expect(res.status, `${owner ? 'owner' : 'no credential'} ${alt(p)}`).toBe(403);
        expect(res.body).toEqual(REFUSAL);
      }
    }
    // The same form of an ordinary file still reads.
    expect((await read(app, alt(path.join(otherRepo, 'readme.md')))).body.content).toBe('other repository');
    // A project that is opened by the second path of the home folder cannot download a secret either.
    const viaAlt = await secretApp(alt(home));
    for (const p of ['.dispatch/access-token', '.ssh/id_ed25519']) {
      expect((await request(viaAlt).get('/api/sessions/s1/files/download').query({ path: p })).status, p).toBe(403);
      expect((await read(viaAlt, p)).status, p).toBe(403);
    }
  });

  it('an absolute read of a file in another repository still answers 200', async () => {
    const app = await secretApp();
    for (const owner of [true, false]) {
      const res = await read(app, path.join(otherRepo, 'readme.md'), owner);
      expect(res.status).toBe(200);
      expect(res.body.content).toBe('other repository');
    }
    expect((await read(app, 'ok.txt')).body.content).toBe('fine');
  });

  it('an ordinary file in the data dir still reads; a project that IS the data dir cannot read the token by a relative path', async () => {
    const role = await read(await secretApp(), path.join(dataDir, 'roles', 'reviewer', 'role.md'));
    expect(role.status).toBe(200);
    expect(role.body.content).toBe('a role file');
    const app = await secretApp(dataDir);
    expect((await read(app, 'roles/reviewer/role.md')).status).toBe(200);
    const res = await read(app, 'access-token', true);
    expect(res.status).toBe(403);
    expect(res.body).toEqual(REFUSAL);
  });
});
