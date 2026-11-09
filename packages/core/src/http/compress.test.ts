import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import zlib from 'node:zlib';
import express from 'express';
import { jsonCompression } from './compress.js';

describe('jsonCompression', () => {
  let server: http.Server; let base: string;
  const big = { items: Array.from({ length: 100 }, (_, i) => ({ id: i, text: `line ${i} of a transcript, with words that repeat` })) };
  const small = { ok: true, note: 'x'.repeat(150) };

  beforeAll(async () => {
    const app = express();
    app.use(jsonCompression());
    app.get('/big', (_req, res) => { res.json(big); });
    app.get('/small', (_req, res) => { res.json(small); });
    app.get('/secret', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(big); });
    app.get('/status', (_req, res) => { res.status(409).json(big); });
    app.get('/stream', (_req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.write('data: ' + 'y'.repeat(5000) + '\n\n'); res.end(); });
    app.get('/vary', (_req, res) => { res.setHeader('Vary', 'Origin'); res.json(big); });
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server.close(); });

  const get = (p: string, headers: Record<string, string> = {}) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    http.get(base + p, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });

  it('a 5 KB JSON body is sent with br when the client accepts it', async () => {
    expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(5000);
    const r = await get('/big', { 'Accept-Encoding': 'gzip, deflate, br' });
    expect(r.status).toBe(200);
    expect(r.headers['content-encoding']).toBe('br');
    expect(r.headers['content-type']).toMatch(/application\/json/);
    expect(String(r.headers['vary'])).toMatch(/Accept-Encoding/i);
    expect(Number(r.headers['content-length'])).toBe(r.body.length);
    expect(r.body.length).toBeLessThan(Buffer.byteLength(JSON.stringify(big)) / 2);
  });

  it('a 200-byte body is not compressed', async () => {
    const r = await get('/small', { 'Accept-Encoding': 'br, gzip' });
    expect(r.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(r.body.toString())).toEqual(small);
  });

  it('a no-store response is not compressed', async () => {
    const r = await get('/secret', { 'Accept-Encoding': 'br, gzip' });
    expect(r.headers['content-encoding']).toBeUndefined();
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(r.body.toString())).toEqual(big);
  });

  it('the decoded body equals the object', async () => {
    const br = await get('/big', { 'Accept-Encoding': 'br' });
    expect(JSON.parse(zlib.brotliDecompressSync(br.body).toString())).toEqual(big);
    const gz = await get('/big', { 'Accept-Encoding': 'gzip' });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(zlib.gunzipSync(gz.body).toString())).toEqual(big);
  });

  it('a client that accepts no encoding gets the plain body', async () => {
    const r = await get('/big');
    expect(r.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(r.body.toString())).toEqual(big);
  });

  it('keeps the status code and an existing Vary value', async () => {
    const s = await get('/status', { 'Accept-Encoding': 'br' });
    expect(s.status).toBe(409);
    expect(s.headers['content-encoding']).toBe('br');
    const v = await get('/vary', { 'Accept-Encoding': 'br' });
    expect(String(v.headers['vary'])).toMatch(/Origin/);
    expect(String(v.headers['vary'])).toMatch(/Accept-Encoding/);
  });

  it('a compressed response still has an ETag, and a matching If-None-Match answers 304', async () => {
    const first = await get('/big', { 'Accept-Encoding': 'br' });
    const etag = String(first.headers['etag']);
    expect(etag.length).toBeGreaterThan(2);
    const second = await get('/big', { 'Accept-Encoding': 'br', 'If-None-Match': etag });
    expect(second.status).toBe(304);
    expect(second.body.length).toBe(0);
  });

  it('does not touch a stream response', async () => {
    const r = await get('/stream', { 'Accept-Encoding': 'br, gzip' });
    expect(r.headers['content-encoding']).toBeUndefined();
    expect(r.body.toString()).toContain('y'.repeat(5000));
  });

  it('the threshold option is honoured', async () => {
    const app = express();
    app.use(jsonCompression({ thresholdBytes: 100 }));
    app.get('/small', (_req, res) => { res.json(small); });
    const s = app.listen(0);
    await new Promise((r) => s.once('listening', r));
    const r = await new Promise<http.IncomingMessage>((resolve) => http.get(`http://127.0.0.1:${(s.address() as { port: number }).port}/small`, { headers: { 'Accept-Encoding': 'br' } }, (res) => { res.resume(); resolve(res); }));
    expect(r.headers['content-encoding']).toBe('br');
    s.close();
  });
});
