import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

// NOTE: this file must NEVER vi.mock('child_process') — createApp shells out at boot.
import { isLoopbackAddress, isLoopbackHost, type RevealClient } from '../../src/files/reveal.js';
import { platform } from '../../src/platform/index.js';
import { createApp } from '../../src/server.js';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** Mirrors darwin/linux's real isLocalClient loopback rule, independent of which platform this
 *  suite happens to run on — the route tests below assert route plumbing, not per-OS behavior
 *  (that's the platform module's own conformance suite). */
function isGenuinelyLocal(client: RevealClient): boolean {
  return !client.proxied && isLoopbackAddress(client.remoteAddress) && isLoopbackHost(client.host);
}

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

    const after = listUploadTempFiles();
    const newTempFiles = [...after].filter(name => !before.has(name));

    expect(res.status).toBe(400);
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

  it('serves an avif image rather than 415', async () => {
    fs.writeFileSync(path.join(tmpDir, 'shot.avif'), Buffer.from([0x00, 0x01, 0x02]));
    const res = await request(app).get('/api/sessions/s1/files/image?path=shot.avif');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/avif');
  });

  it('serves a bmp image rather than 415', async () => {
    fs.writeFileSync(path.join(tmpDir, 'shot.bmp'), Buffer.from([0x42, 0x4d]));
    const res = await request(app).get('/api/sessions/s1/files/image?path=shot.bmp');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/bmp');
  });

  describe('POST /reveal', () => {
    let originalFileManagerName: string | null;
    let revealSpy: ReturnType<typeof vi.spyOn>;
    let isLocalClientSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      // Pin a capable platform (non-null file manager) regardless of which OS this suite runs on;
      // isLocalClient wraps the REAL loopback predicate so the route's own plumbing — reading the
      // socket peer, not req.ip — is genuinely exercised, not just stubbed away.
      originalFileManagerName = platform.fileManagerName;
      (platform as { fileManagerName: string | null }).fileManagerName = 'Finder';
      isLocalClientSpy = vi.spyOn(platform, 'isLocalClient').mockImplementation(isGenuinelyLocal);
      revealSpy = vi.spyOn(platform, 'revealInFileManager').mockResolvedValue(undefined);
    });

    afterEach(() => {
      (platform as { fileManagerName: string | null }).fileManagerName = originalFileManagerName;
      vi.restoreAllMocks();
    });

    it('reveals every requested path, resolved to absolute', async () => {
      fs.writeFileSync(path.join(tmpDir, 'b.png'), 'x');
      const res = await request(app)
        .post('/api/sessions/s1/files/reveal')
        .send({ paths: ['hello.txt', 'b.png'] });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(revealSpy).toHaveBeenCalledWith([
        path.join(tmpDir, 'hello.txt'),
        path.join(tmpDir, 'b.png'),
      ]);
    });

    it('decides capability from the socket peer address, not req.ip', async () => {
      // With `trust proxy` on, Express derives req.ip from X-Forwarded-For — so req.ip is now
      // '8.8.8.8' while the real socket peer stays loopback. THIS is what makes the assertion
      // bite: an implementation that reached for req.ip would hand isLocalClient '8.8.8.8'.
      app.set('trust proxy', true);
      await request(app)
        .post('/api/sessions/s1/files/reveal')
        .set('X-Forwarded-For', '8.8.8.8')
        .send({ paths: ['hello.txt'] });

      const [client] = isLocalClientSpy.mock.calls[0];
      expect(client.remoteAddress).toMatch(/^(::1|::ffff:127\.|127\.)/);
      expect(client.remoteAddress).not.toBe('8.8.8.8');
      expect(client.proxied).toBe(true);   // ...and the forwarding header itself is fatal
    });

    it('refuses a forwarded request outright, even over a loopback socket', async () => {
      // A proxy in front means the browser is NOT on this machine. The socket peer address alone
      // cannot tell you that; the header can.
      app.set('trust proxy', true);
      const res = await request(app)
        .post('/api/sessions/s1/files/reveal')
        .set('X-Forwarded-For', '8.8.8.8')
        .send({ paths: ['hello.txt'] });
      expect(res.status).toBe(403);
      expect(revealSpy).not.toHaveBeenCalled();
    });

    it('THE TUNNEL CASE: refuses a loopback socket carrying a public Host header', async () => {
      // cloudflared runs on this machine and dials http://localhost:3456, so the daemon sees a
      // real 127.0.0.1 peer for a browser anywhere in the world. Only the Host header gives it away.
      const res = await request(app)
        .post('/api/sessions/s1/files/reveal')
        .set('Host', 'dispatch.example.com')
        .send({ paths: ['hello.txt'] });
      expect(res.status).toBe(403);
      expect(revealSpy).not.toHaveBeenCalled();
    });

    it('still reveals for a clean loopback request with a loopback Host', async () => {
      // The legitimate local browser must keep working — supertest dials 127.0.0.1 and sends
      // `Host: 127.0.0.1:<port>` with no forwarding headers.
      const res = await request(app)
        .post('/api/sessions/s1/files/reveal')
        .send({ paths: ['hello.txt'] });
      expect(res.status).toBe(200);
      expect(revealSpy).toHaveBeenCalledWith([path.join(tmpDir, 'hello.txt')]);
    });

    it('rejects a selection larger than the 256-path bound', async () => {
      const paths = Array.from({ length: 257 }, (_, i) => `f${i}.txt`);
      const res = await request(app).post('/api/sessions/s1/files/reveal').send({ paths });
      expect(res.status).toBe(400);
      expect(revealSpy).not.toHaveBeenCalled();
    });

    it('never shells out when the caller is not capable', async () => {
      isLocalClientSpy.mockReturnValue(false); // remote client
      const res = await request(app)
        .post('/api/sessions/s1/files/reveal')
        .send({ paths: ['hello.txt'] });
      expect(res.status).toBe(403);
      expect(revealSpy).not.toHaveBeenCalled();
    });

    it('never shells out when the platform has no native file manager', async () => {
      (platform as { fileManagerName: string | null }).fileManagerName = null; // headless Linux
      const res = await request(app)
        .post('/api/sessions/s1/files/reveal')
        .send({ paths: ['hello.txt'] });
      expect(res.status).toBe(403);
      expect(revealSpy).not.toHaveBeenCalled();
    });

    it('rejects path traversal', async () => {
      const res = await request(app)
        .post('/api/sessions/s1/files/reveal')
        .send({ paths: ['../../etc/passwd'] });
      expect(res.status).toBe(403);
      expect(revealSpy).not.toHaveBeenCalled();
    });

    it('rejects an empty selection', async () => {
      const res = await request(app).post('/api/sessions/s1/files/reveal').send({ paths: [] });
      expect(res.status).toBe(400);
      expect(revealSpy).not.toHaveBeenCalled();
    });
  });
});
