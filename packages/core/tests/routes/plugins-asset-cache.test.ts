// W2-H: a plugin file asked for with the plugin's current stamp (`?v=<stamp>`, as the app's loader does)
// can be kept for good and goes out compressed. Any other request stays as it was: no-cache, as-is.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';
import { HTML_SANDBOX_CSP } from '../../src/http/active-content.js';
import { IMMUTABLE } from '../../src/web-assets.js';

describe('plugin file cache headers (W2-H)', () => {
  let tmp: string;
  let server: http.Server;
  let stamp: number;
  const BUNDLE = `export default () => { /* ${'plugin code '.repeat(400)} */ };`;
  // The bytes as a Buffer. The client decodes br and gzip by itself; the headers say what went over the wire.
  const raw = (url: string, headers: Record<string, string> = {}) => request(server).get(url).set(headers).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cache-'));
    const dir = path.join(tmp, 'plugins', 'p');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'p', name: 'p', version: '1.0.0', web: 'web.js' }));
    fs.writeFileSync(path.join(dir, 'web.js'), BUNDLE);
    fs.writeFileSync(path.join(dir, 'page.html'), `<p>${'hello '.repeat(400)}</p>`);
    fs.writeFileSync(path.join(dir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
    const db = new Database(':memory:');
    initSchema(db);
    const app = createApp({ db, skipPty: true, pluginsDir: path.join(tmp, 'plugins'), bundledDir: null, secretsDir: tmp });
    // 127.0.0.1 only: supertest's own server listens on every address, and another program on this computer can then answer.
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const rows = (await request(server).get('/api/plugins')).body.plugins as { id: string; stamp: number }[];
    stamp = rows.find((r) => r.id === 'p')!.stamp;
    expect(stamp).toBeGreaterThan(0);
  });
  afterEach(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('a current stamp gives immutable and an encoding', async () => {
    const br = await raw(`/plugins/p/web.js?v=${stamp}`, { 'Accept-Encoding': 'br' });
    expect(br.status).toBe(200);
    expect(br.headers['cache-control']).toBe(IMMUTABLE);
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers.vary).toMatch(/Accept-Encoding/i);
    expect(br.headers['content-type']).toMatch(/javascript/);
    expect((br.body as Buffer).toString('utf8')).toBe(BUNDLE);
    expect(Number(br.headers['content-length'])).toBeLessThan(BUNDLE.length / 4);

    const gz = await raw(`/plugins/p/web.js?v=${stamp}`, { 'Accept-Encoding': 'gzip' });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gz.headers['cache-control']).toBe(IMMUTABLE);
    expect((gz.body as Buffer).toString('utf8')).toBe(BUNDLE);
  });

  it('a current stamp and a client that takes no encoding: immutable, sent as-is', async () => {
    const res = await raw(`/plugins/p/web.js?v=${stamp}`, { 'Accept-Encoding': 'identity' });
    expect(res.headers['cache-control']).toBe(IMMUTABLE);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect((res.body as Buffer).toString('utf8')).toBe(BUNDLE);
  });

  it('an old stamp gives no-cache', async () => {
    for (const v of [String(stamp - 1), String(stamp + 1), '0', 'abc', '', `${stamp}x`]) {
      const res = await raw(`/plugins/p/web.js?v=${encodeURIComponent(v)}`, { 'Accept-Encoding': 'br' });
      expect(res.status, v).toBe(200);
      expect(res.headers['cache-control'], v).toBe('no-cache');
      expect(res.headers['content-encoding'], v).toBeUndefined();
      expect((res.body as Buffer).toString('utf8')).toBe(BUNDLE);
    }
  });

  it('no stamp gives no-cache, as before', async () => {
    const res = await raw('/plugins/p/web.js', { 'Accept-Encoding': 'br' });
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['content-encoding']).toBeUndefined();
    expect((res.body as Buffer).toString('utf8')).toBe(BUNDLE);
  });

  it('a file that changed gets a new stamp: the old address is no-cache again and gives the new bytes', async () => {
    const file = path.join(tmp, 'plugins', 'p', 'web.js');
    fs.writeFileSync(file, 'export default 2;');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    const old = await raw(`/plugins/p/web.js?v=${stamp}`, { 'Accept-Encoding': 'br' });
    expect(old.headers['cache-control']).toBe('no-cache');
    expect((old.body as Buffer).toString('utf8')).toBe('export default 2;');
    const rows = (await request(server).get('/api/plugins')).body.plugins as { id: string; stamp: number }[];
    const next = rows.find((r) => r.id === 'p')!.stamp;
    expect(next).not.toBe(stamp);
    const now = await raw(`/plugins/p/web.js?v=${next}`, { 'Accept-Encoding': 'br' });
    expect(now.headers['cache-control']).toBe(IMMUTABLE);
    expect((now.body as Buffer).toString('utf8')).toBe('export default 2;');
  });

  it('an HTML page keeps its sandbox headers with a current stamp', async () => {
    const res = await raw(`/plugins/p/page.html?v=${stamp}`, { 'Accept-Encoding': 'gzip' });
    expect(res.headers['content-security-policy']).toBe(HTML_SANDBOX_CSP);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['cache-control']).toBe(IMMUTABLE);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect((res.body as Buffer).toString('utf8')).toContain('hello hello');
  });

  it('an image with a current stamp is immutable and not compressed', async () => {
    const res = await raw(`/plugins/p/shot.png?v=${stamp}`, { 'Accept-Encoding': 'br' });
    expect(res.headers['cache-control']).toBe(IMMUTABLE);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect((res.body as Buffer).length).toBe(8);
  });

  it('a missing file and a disabled plugin stay 404 with a stamp', async () => {
    expect((await raw(`/plugins/p/nope.js?v=${stamp}`)).status).toBe(404);
    await request(server).post('/api/plugins/p/disable');
    expect((await raw(`/plugins/p/web.js?v=${stamp}`)).status).toBe(404);
  });
});
