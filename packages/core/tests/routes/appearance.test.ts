import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createAppearanceRouter, customIconHandler } from '../../src/routes/appearance.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-appearance-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

// Tiny valid PNG (1x1 transparent) — enough to pass the magic-byte check.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function app() {
  const a = express();
  a.use(express.json({ limit: '10mb' }));
  a.use('/api/appearance', createAppearanceRouter(dir));
  a.get('/icons/:name', customIconHandler(dir));
  a.get('/icons/:name', (_req, res) => res.status(200).send('static-fallback'));
  return a;
}

describe('PUT /api/appearance/icons', () => {
  it('stores uploaded PNGs and serves them back in place of the bundle', async () => {
    const put = await request(app()).put('/api/appearance/icons').send({ icons: { 'apple-touch-icon.png': PNG_B64 } });
    expect(put.status).toBe(200);
    expect(put.body.written).toEqual(['apple-touch-icon.png']);

    const got = await request(app()).get('/icons/apple-touch-icon.png');
    expect(got.status).toBe(200);
    expect(got.body.readUInt32BE(0)).toBe(0x89504e47);
  });

  it('falls through to the static bundle when no custom icon exists', async () => {
    const got = await request(app()).get('/icons/icon-192.png');
    expect(got.text).toBe('static-fallback');
  });

  it('rejects unknown names (no path traversal into the data dir)', async () => {
    const res = await request(app()).put('/api/appearance/icons').send({ icons: { '../evil.png': PNG_B64 } });
    expect(res.status).toBe(400);
    expect(fs.existsSync(path.join(dir, 'evil.png'))).toBe(false);
  });

  it('rejects non-PNG payloads', async () => {
    const res = await request(app()).put('/api/appearance/icons').send({ icons: { 'icon-192.png': Buffer.from('<svg/>').toString('base64') } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a PNG/);
  });
});
