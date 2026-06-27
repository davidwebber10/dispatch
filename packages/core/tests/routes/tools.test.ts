import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';

let toolsDir: string; let app: any;
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-rt-'));
  toolsDir = path.join(root, 'tools');
  const db = new Database(':memory:'); initSchema(db);
  app = createApp({ db, skipPty: true, toolsDir });
});
afterEach(() => fs.rmSync(path.dirname(toolsDir), { recursive: true, force: true }));

it('GET /api/tools returns the manifest with status', async () => {
  const res = await request(app).get('/api/tools');
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body.tools)).toBe(true);
  const jq = res.body.tools.find((t: any) => t.name === 'jq');
  expect(jq).toBeTruthy();
  expect(jq).toHaveProperty('installed');
  expect(jq).toHaveProperty('authed');
});
