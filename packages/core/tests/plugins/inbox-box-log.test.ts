import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';
import { configureRefusalLog } from '../../src/auth/route-policy.js';
import { setBoxLogForTest } from '../../src/os/box-log.js';
import { KeysManager } from '../routes/keys-manager.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const DROP = '0f8e2b1c-4d5a-4e6f-9a7b-1c2d3e4f5a6b';

/** The box log answers "did the drop reach the Inbox?" and "how many did the list hold?", never with content. */
describe('Inbox box log lines', () => {
  let app: any; let tmp: string; let lines: Record<string, unknown>[];

  beforeEach(() => {
    configureRefusalLog({ log: () => {} });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-log-'));
    const db = new Database(':memory:'); initSchema(db);
    app = createApp({ db, skipPty: true, pluginsDir: path.join(tmp, 'plugins'), bundledDir: path.join(REPO, 'packages/plugins'), secretsDir: tmp, managers: new Map([['claude-code', new KeysManager().asManager()]]) });
    lines = [];
    setBoxLogForTest({ enabled: true, sink: (l) => lines.push(JSON.parse(l)) });
  });
  afterEach(() => {
    setBoxLogForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('logs plugin.data.put with the drop id, kind and file count, and inbox.list with the count; no title, note or text', async () => {
    const value = { id: DROP, title: 'A private title', note: 'a private note', text: 'private text', kind: 'link', url: 'https://example.com/x', files: [{ name: 'a.png' }, { name: 'b.pdf' }], seenAt: null };
    const put = await request(app).put(`/api/plugins/previews/data/preview:${DROP}`).send({ value });
    expect(put.status).toBe(200);
    await request(app).put('/api/plugins/previews/data/other-key').send({ value: { x: 1 } });
    const list = await request(app).get('/api/plugins/previews/data?values=1');
    expect(list.status).toBe(200);

    const puts = lines.filter((l) => l.event === 'plugin.data.put');
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ plugin: 'previews', drop: DROP, kind: 'link', files: 2, seen: false });
    const lists = lines.filter((l) => l.event === 'inbox.list');
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({ count: 1, values: true });
    // A kind that is not one of the tool's is logged as `other`, never as its free text.
    await request(app).put('/api/plugins/previews/data/preview:1f8e2b1c-4d5a-4e6f-9a7b-1c2d3e4f5a6b').send({ value: { kind: 'please read this note', files: [] } });
    expect(lines.filter((l) => l.event === 'plugin.data.put').pop()).toMatchObject({ kind: 'other' });
    const all = JSON.stringify(lines);
    for (const s of ['A private title', 'a private note', 'private text', 'a.png', 'example.com', 'please read']) expect(all).not.toContain(s);
  });
});
