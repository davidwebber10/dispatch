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
