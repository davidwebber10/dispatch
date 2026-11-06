import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import http from 'http';
import express from 'express';
import { compressedAssets, pickEncoding, IMMUTABLE } from './web-assets.js';

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
