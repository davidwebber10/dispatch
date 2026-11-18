// GET /api/terminals/:terminalId/journal (W3-D): the REST page of the message journal.
import { ClaudeStructuredSessionManager } from '../structured/manager.js';
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as terminalsDb from '../db/terminals.js';
import * as sessionsDb from '../db/sessions.js';
import { createApp } from '../server.js';
import { configureRefusalLog } from '../auth/route-policy.js';
import { setDurableIdempotencyStore } from '../http/idempotency.js';
import { MessageJournal } from '../journal/journal.js';
import { AcpStructuredSessionManager } from '../structured/acp-manager.js';
import type { IStructuredManager } from '../structured/manager.js';

const fakeAcp = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'structured', 'fake-acp-agent.mjs');
const user = (text: string) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const dirs: string[] = [];
const managers: IStructuredManager[] = [];

afterEach(() => {
  for (const m of managers.splice(0)) m.killAll();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  setDurableIdempotencyStore(null);
});

function tmp(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'w3d-route-')); dirs.push(d); return d; }

/** A daemon app on `db` with one ACP manager for Grok (the real manager; the agent is the fake). */
function daemon(db: Database.Database) {
  configureRefusalLog({ log: () => {} });
  initSchema(db);
  const grok = new AcpStructuredSessionManager('grok');
  managers.push(grok);
  // The daemon builder needs a Claude manager too (W3-A); this one is never used here.
  const claude = new ClaudeStructuredSessionManager();
  managers.push(claude as never);
  const app = createApp({ db, skipPty: true, managers: new Map<string, IStructuredManager>([['claude-code', claude], ['grok', grok]]) });
  return { app, grok, journal: new MessageJournal(db) };
}
function seedProjects(db: Database.Database) {
  const root = tmp();
  for (const id of ['A', 'B']) { const dir = path.join(root, id); fs.mkdirSync(dir); sessionsDb.create(db, { id, provider: 'claude-code', name: id, workingDir: dir }); }
  for (const [id, sessionId] of [['tA', 'A'], ['tA2', 'A'], ['tB', 'B']]) terminalsDb.create(db, { id, sessionId, type: 'grok', label: id, config: { transport: 'structured', role: 'agent' } });
}
const once = (m: IStructuredManager, event: string, id: string, ms = 8000) => new Promise<unknown[]>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout waiting for '${event}'`)), ms);
  const on = (eid: string, ...rest: unknown[]) => { if (eid === id) { clearTimeout(t); m.off(event, on); resolve(rest); } };
  m.on(event, on);
});

describe('GET /api/terminals/:terminalId/journal', () => {
  it('gives the newest items, and pages with before and after', async () => {
    const db = new Database(':memory:');
    const { app, journal } = daemon(db);
    seedProjects(db);
    for (let n = 1; n <= 10; n++) journal.append('tA', { kind: 'user', payload: user(`m${n}`) });
    const newest = await request(app).get('/api/terminals/tA/journal?limit=3').expect(200);
    expect(newest.body.items.map((i: any) => i.seq)).toEqual([8, 9, 10]);
    expect(newest.body).toMatchObject({ firstSeq: 1, lastSeq: 10, hasMore: true });
    expect(Object.keys(newest.body.items[0]).sort()).toEqual(['at', 'kind', 'payload', 'seq']);
    const older = await request(app).get('/api/terminals/tA/journal?before=8&limit=3').expect(200);
    expect(older.body.items.map((i: any) => i.seq)).toEqual([5, 6, 7]);
    const after = await request(app).get('/api/terminals/tA/journal?after=8').expect(200);
    expect(after.body.items.map((i: any) => i.seq)).toEqual([9, 10]);
    expect(after.body.hasMore).toBe(false);
    const empty = await request(app).get('/api/terminals/tA2/journal').expect(200);
    expect(empty.body).toEqual({ items: [], firstSeq: 0, lastSeq: 0, hasMore: false });
  });

  it('refuses a bad parameter, and an unknown thread is 404', async () => {
    const db = new Database(':memory:');
    const { app } = daemon(db);
    seedProjects(db);
    await request(app).get('/api/terminals/tA/journal?before=abc').expect(400);
    await request(app).get('/api/terminals/tA/journal?before=3&after=1').expect(400);
    await request(app).get('/api/terminals/tA/journal?limit=0').expect(400);
    await request(app).get('/api/terminals/nope/journal').expect(404);
  });

  it('a thread key reads its own journal', async () => {
    const db = new Database(':memory:');
    const { app, journal } = daemon(db);
    seedProjects(db);
    journal.append('tA', { kind: 'user', payload: user('mine') });
    journal.append('tA2', { kind: 'user', payload: user('same project') });
    journal.append('tB', { kind: 'user', payload: user('another project') });
    const key = (id: string) => ({ Authorization: `Bearer ${(app.locals.keys.mint({ kind: 'thread', terminalId: id }).key as string)}` });
    const own = await request(app).get('/api/terminals/tA/journal').set(key('tA')).expect(200);
    expect(own.body.items.map((i: any) => i.payload.message.content[0].text)).toEqual(['mine']);
    // The same rule as the conversation route: what a thread key may read there, it may read here.
    for (const id of ['tA2', 'tB']) {
      const conv = await request(app).get(`/api/terminals/${id}/conversation`).set(key('tA'));
      const jour = await request(app).get(`/api/terminals/${id}/journal`).set(key('tA'));
      expect(jour.status).toBe(conv.status);
    }
    // A token that is no key gets the answer the conversation route gives it.
    const bad = { Authorization: 'Bearer dsp_thread_not-a-real-key' };
    expect((await request(app).get('/api/terminals/tA/journal').set(bad)).status).toBe((await request(app).get('/api/terminals/tA/conversation').set(bad)).status);
  });

  // Final review of v4.5.0, I2: an image that the journal keeps outside its payload is read from here.
  it('serves an image that the journal keeps, as a picture and nothing else', async () => {
    const db = new Database(':memory:');
    const { app, journal } = daemon(db);
    seedProjects(db);
    const data = Buffer.alloc(300 * 1024); for (let i = 0; i < data.length; i++) data[i] = (i * 31 + (i >> 8)) & 0xff;
    journal.append('tA', { kind: 'user', payload: { type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: data.toString('base64') } }] } } });
    const page = await request(app).get('/api/terminals/tA/journal').expect(200);
    const source = page.body.items[0].payload.message.content[0].source;
    expect(source).toMatchObject({ type: 'journal_image', media_type: 'image/png', thread: 'tA' });
    const res = await request(app).get(`/api/terminals/tA/journal/images/${source.id}`).buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); }).expect(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect((res.body as Buffer).equals(data)).toBe(true);
    // Another thread, an id that is no image, an id that is no id, an unknown thread.
    await request(app).get(`/api/terminals/tA2/journal/images/${source.id}`).expect(404);
    await request(app).get(`/api/terminals/tA/journal/images/${'0'.repeat(64)}`).expect(404);
    await request(app).get('/api/terminals/tA/journal/images/..%2F..%2Fsecret').expect(400); // not a canonical path
    await request(app).get(`/api/terminals/nope/journal/images/${source.id}`).expect(404);
    // The key rules are the ones of the journal page.
    const key = (id: string) => ({ Authorization: `Bearer ${(app.locals.keys.mint({ kind: 'thread', terminalId: id }).key as string)}` });
    await request(app).get(`/api/terminals/tA/journal/images/${source.id}`).set(key('tA')).expect(200);
    const pageOther = await request(app).get('/api/terminals/tB/journal').set(key('tA'));
    const imageOther = await request(app).get(`/api/terminals/tB/journal/images/${source.id}`).set(key('tA'));
    expect(imageOther.status === 404 || imageOther.status === pageOther.status).toBe(true);
    const bad = { Authorization: 'Bearer dsp_thread_not-a-real-key' };
    expect((await request(app).get(`/api/terminals/tA/journal/images/${source.id}`).set(bad)).status).toBe((await request(app).get('/api/terminals/tA/journal').set(bad)).status);
  });

  it('a key in an item is redacted', async () => {
    const db = new Database(':memory:');
    const { app, journal } = daemon(db);
    seedProjects(db);
    const secret = app.locals.keys.mint({ kind: 'thread', terminalId: 'tA' }).key as string;
    journal.append('tA', { kind: 'user', payload: user(`my key is ${secret}`) });
    const res = await request(app).get('/api/terminals/tA/journal').expect(200);
    expect(JSON.stringify(res.body)).not.toContain(secret);
  });

  it('a Grok thread returns history after a new daemon instance on the same database', async () => {
    const file = path.join(tmp(), 'dispatch.db');
    const stateDir = tmp();
    const spawn = (m: AcpStructuredSessionManager, resumeId?: string) =>
      m.spawn('tA', { command: process.execPath, args: [fakeAcp], workDir: os.tmpdir(), env: { FAKE_ACP_STATE_DIR: stateDir }, ...(resumeId ? { resumeId } : {}) } as any);

    // The first daemon: two turns in a Grok thread.
    const db1 = new Database(file);
    const first = daemon(db1);
    seedProjects(db1);
    const session = once(first.grok, 'session', 'tA');
    spawn(first.grok);
    const [sessionId] = await session;
    for (const words of ['TOOL one', 'two']) { const idle = once(first.grok, 'idle', 'tA'); first.grok.sendMessage('tA', words); await idle; }
    const before = (await request(first.app).get('/api/terminals/tA/journal?limit=500').expect(200)).body;
    expect(before.items.map((i: any) => i.kind)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant', 'result', 'user', 'assistant', 'assistant', 'result']);
    first.grok.killAll();
    db1.close();

    // A new daemon on the same database file. No process of the thread runs: the history is there at once.
    const db2 = new Database(file);
    const second = daemon(db2);
    const cold = (await request(second.app).get('/api/terminals/tA/journal?limit=500').expect(200)).body;
    expect(cold).toEqual(before); // same items, same sequences

    // The thread resumes (the agent replays its history) and runs one more turn: no item twice, the sequence goes on.
    spawn(second.grok, sessionId as string);
    const idle = once(second.grok, 'idle', 'tA');
    second.grok.sendMessage('tA', 'three');
    await idle;
    const after = (await request(second.app).get('/api/terminals/tA/journal?limit=500').expect(200)).body;
    expect(after.items.slice(0, 10)).toEqual(before.items);
    expect(after.items.map((i: any) => i.seq)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    expect(after.items.slice(10).map((i: any) => i.kind)).toEqual(['user', 'assistant', 'assistant', 'result']);
    second.grok.killAll();
    db2.close();
  });
});
