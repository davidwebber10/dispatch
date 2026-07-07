import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('file routes', () => {
  let app: any;
  let tmpDir: string;
  const uploadTmpDir = '/tmp/commandcenter-uploads';

  function listUploadTempFiles(): Set<string> {
    if (!fs.existsSync(uploadTmpDir)) return new Set();
    return new Set(fs.readdirSync(uploadTmpDir));
  }

  beforeEach(() => {
    const db = new Database(':memory:');
    initSchema(db);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commandcenter-test-'));
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'test', workingDir: tmpDir });
    fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'world');
    app = createApp({ db, skipPty: true });
  });

  it('lists directory', async () => {
    const res = await request(app).get('/api/sessions/s1/files?path=.');
    expect(res.status).toBe(200);
    expect(res.body.some((f: any) => f.name === 'hello.txt')).toBe(true);
  });

  it('reads a file', async () => {
    const res = await request(app).get('/api/sessions/s1/files/read?path=hello.txt');
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('world');
  });

  it('blocks path traversal', async () => {
    const res = await request(app).get('/api/sessions/s1/files/read?path=../../etc/passwd');
    expect(res.status).toBe(403);
  });

  it('blocks sibling paths that share the working directory prefix', async () => {
    const sibling = `${tmpDir}-sibling`;
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, 'secret.txt'), 'nope');

    const res = await request(app)
      .get(`/api/sessions/s1/files/read?path=../${path.basename(sibling)}/secret.txt`);

    expect(res.status).toBe(403);
  });

  it('renames files and folders inside the working directory', async () => {
    fs.mkdirSync(path.join(tmpDir, 'folder'));

    const fileRes = await request(app)
      .post('/api/sessions/s1/files/rename')
      .send({ from: 'hello.txt', to: 'renamed.txt' });
    expect(fileRes.status).toBe(200);
    expect(fs.existsSync(path.join(tmpDir, 'renamed.txt'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'hello.txt'))).toBe(false);

    const folderRes = await request(app)
      .post('/api/sessions/s1/files/rename')
      .send({ from: 'folder', to: 'renamed-folder' });
    expect(folderRes.status).toBe(200);
    expect(fs.existsSync(path.join(tmpDir, 'renamed-folder'))).toBe(true);
  });

  it('uploads files into .dispatch/inbox with sanitized names', async () => {
    const res = await request(app)
      .post('/api/sessions/s1/files/inbox')
      .attach('file', Buffer.from('inbox content'), {
        filename: '../My weird file @#$%.txt',
        contentType: 'text/plain',
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.path).toMatch(/^\.dispatch\/inbox\/\d+-[a-z0-9]+-My-weird-file-.txt$/);
    expect(res.body.absolutePath).toBe(path.join(tmpDir, res.body.path));
    expect(res.body.absolutePath.startsWith(path.join(tmpDir, '.dispatch', 'inbox'))).toBe(true);
    expect(fs.readFileSync(res.body.absolutePath, 'utf-8')).toBe('inbox content');
  });

  it('returns 413 JSON when inbox uploads exceed 50 MB', async () => {
    const res = await request(app)
      .post('/api/sessions/s1/files/inbox')
      .attach('file', Buffer.alloc(50 * 1024 * 1024 + 1), {
        filename: 'too-large.txt',
        contentType: 'text/plain',
      });

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'File is larger than 50 MB' });
  });

  it('cleans up the multer temp file when inbox storage fails after upload', async () => {
    fs.mkdirSync(uploadTmpDir, { recursive: true });
    const before = listUploadTempFiles();
    fs.writeFileSync(path.join(tmpDir, '.dispatch'), 'not a directory');

    const res = await request(app)
      .post('/api/sessions/s1/files/inbox')
      .attach('file', Buffer.from('orphan check'), {
        filename: 'cleanup.txt',
        contentType: 'text/plain',
      });

    expect(res.status).toBe(400);

    // Poll until the temp dir drains (handles slow handle-release on Windows-CI).
    // safeUnlinkSync retries for up to ~1s; we allow 3s total here.
    const deadline = Date.now() + 3000;
    let newTempFiles: string[] = [];
    while (Date.now() < deadline) {
      const after = listUploadTempFiles();
      newTempFiles = [...after].filter(name => !before.has(name));
      if (newTempFiles.length === 0) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    expect(newTempFiles).toEqual([]);
  });

  // Collect the response body as raw bytes so binary integrity can be asserted.
  function binaryParser(res: any, cb: (err: Error | null, body: Buffer) => void) {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  }

  it('downloads a file as an attachment, byte-for-byte', async () => {
    // Non-UTF-8 bytes: proves the endpoint is binary-safe (unlike /read).
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01]);
    fs.writeFileSync(path.join(tmpDir, 'art.png'), payload);

    const res = await request(app)
      .get('/api/sessions/s1/files/download?path=art.png')
      .buffer(true)
      .parse(binaryParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/octet-stream/);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('filename="art.png"');
    expect(res.body.equals(payload)).toBe(true);
  });

  it('blocks path traversal on download', async () => {
    const res = await request(app).get('/api/sessions/s1/files/download?path=../../etc/passwd');
    expect(res.status).toBe(403);
  });

  it('404s downloading a missing file', async () => {
    const res = await request(app).get('/api/sessions/s1/files/download?path=nope.bin');
    expect(res.status).toBe(404);
  });

  it('404s downloading a directory', async () => {
    fs.mkdirSync(path.join(tmpDir, 'folder'));
    const res = await request(app).get('/api/sessions/s1/files/download?path=folder');
    expect(res.status).toBe(404);
  });
});
