import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import http from 'http';
import express from 'express';
import { compressedAssets, pickEncoding, IMMUTABLE, createIndexProvider } from './web-assets.js';

describe('pickEncoding', () => {
  it('prefers br, then gzip, else none', () => {
    expect(pickEncoding('gzip, deflate, br')).toBe('br');
    expect(pickEncoding('gzip')).toBe('gzip');
    expect(pickEncoding('br;q=0, gzip')).toBe('gzip');
    expect(pickEncoding('identity')).toBeNull();
    expect(pickEncoding(undefined)).toBeNull();
  });
});

describe('compressedAssets', () => {
  let dir: string; let server: http.Server; let base: string;
  const js = 'console.log("hello");\n'.repeat(500);
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-'));
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'assets', 'index-abc.js'), js);
    fs.writeFileSync(path.join(dir, 'assets', 'font.woff2'), 'binary');
    fs.writeFileSync(path.join(dir, 'secret.js'), 'nope');
    const app = express();
    app.use('/assets', compressedAssets(path.join(dir, 'assets')));
    app.use((_req, res) => { res.status(299).send('fell through'); });
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const get = (p: string, ae?: string) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    http.get(base + p, { headers: ae ? { 'Accept-Encoding': ae } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });

  it('sends a script brotli-compressed with a forever cache', async () => {
    const r = await get('/assets/index-abc.js', 'gzip, br');
    expect(r.status).toBe(200);
    expect(r.headers['content-encoding']).toBe('br');
    expect(r.headers['cache-control']).toBe(IMMUTABLE);
    expect(r.headers['content-type']).toMatch(/javascript/);
    expect(r.body.length).toBeLessThan(js.length / 10);
    expect(zlib.brotliDecompressSync(r.body).toString()).toBe(js);
  });

  it('sends gzip to a client that only takes gzip', async () => {
    const r = await get('/assets/index-abc.js', 'gzip');
    expect(r.headers['content-encoding']).toBe('gzip');
    expect(zlib.gunzipSync(r.body).toString()).toBe(js);
  });

  it('leaves the rest to the next handler: no encoding, a font, a missing file, a path outside', async () => {
    expect((await get('/assets/index-abc.js')).status).toBe(299);
    expect((await get('/assets/font.woff2', 'br')).status).toBe(299);
    expect((await get('/assets/missing.js', 'br')).status).toBe(299);
    expect((await get('/assets/..%2Fsecret.js', 'br')).status).toBe(299);
  });
});

// W1-E: index.html is read again when the file changes, so a web rebuild needs no daemon restart.
describe('createIndexProvider', () => {
  let dir: string; let file: string;
  const page = (script: string) => `<!doctype html><html><head><base href="/" /><script type="module" src="./assets/${script}"></script></head><body></body></html>`;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-index-')); file = path.join(dir, 'index.html'); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  /** Writes the file with an mtime that differs from the last one, even on a filesystem with coarse times. */
  let tick = 0;
  const write = (text: string) => { fs.writeFileSync(file, text); tick += 2; const t = new Date(Date.now() + tick * 1000); fs.utimesSync(file, t, t); };

  it('the provider returns new content after the file changes', () => {
    write(page('index-AAAA.js'));
    const index = createIndexProvider(file, '');
    expect(index()).toContain('index-AAAA.js');
    write(page('index-BBBB.js')); // the same size, a new mtime
    expect(index()).toContain('index-BBBB.js');
    expect(index()).not.toContain('index-AAAA.js');
    // The same mtime and a new size is a change too.
    const st = fs.statSync(file);
    fs.writeFileSync(file, page('index-CCCCCC.js'));
    fs.utimesSync(file, st.atime, st.mtime);
    expect(index()).toContain('index-CCCCCC.js');
  });

  it('it keeps the last copy when the file is missing', () => {
    write(page('index-KEEP.js'));
    const index = createIndexProvider(file, '');
    expect(index()).toContain('index-KEEP.js');
    fs.rmSync(file);
    expect(index()).toContain('index-KEEP.js');
    write(''); // a build that has opened the file and not written it yet
    expect(index()).toContain('index-KEEP.js');
    write(page('index-BACK.js'));
    expect(index()).toContain('index-BACK.js');
  });

  it('rewrites <base href> to the mount prefix on every read', () => {
    write(page('index-AAAA.js'));
    const index = createIndexProvider(file, '/u/x/dispatch');
    expect(index()).toContain('<base href="/u/x/dispatch/">');
    write(page('index-BBBB.js'));
    expect(index()).toContain('<base href="/u/x/dispatch/">');
    expect(index()).toContain('index-BBBB.js');
  });

  it('does not read the file again when it did not change', () => {
    write(page('index-AAAA.js'));
    const index = createIndexProvider(file, '');
    index();
    const read = vi.spyOn(fs, 'readFileSync');
    for (let i = 0; i < 20; i++) index();
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
  });
});
