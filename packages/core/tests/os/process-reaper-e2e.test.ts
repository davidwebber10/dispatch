// The idle-process reaper (os/process-reaper.ts) in the daemon's own wiring, with a fake `claude` child
// process: an idle thread's process is stopped, the thread keeps its status, viewing it starts nothing,
// and the next message resumes the saved session (`-r`) and answers. Without the variables nothing is wired.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { MessageJournal } from '../../src/journal/journal.js';
import { DORMANT_KEY, isDormantStop, resetDormantStateForTest } from '../../src/os/process-reaper.js';
import { structuredViewOpener } from '../../src/daemon/sockets.js';
import { handleStructuredConnection } from '../../src/ws/structured.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), '../structured/fake-claude.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | null | false, ms = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timeout');
    await sleep(20);
  }
}

let db: Database.Database;
let dir: string;
let now: number;
const apps: any[] = [];

beforeEach(() => {
  resetDormantStateForTest();
  db = new Database(':memory:');
  initSchema(db);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-e2e-'));
  now = Date.now();
});
afterEach(() => {
  for (const a of apps.splice(0)) { try { a._structuredManager?.killAll?.(); } catch { /* best effort */ } }
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

function app(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const a = createApp({ db, skipPty: true, structuredCommand: { command: process.execPath, args: [fake] }, clock: () => now });
  apps.push(a);
  return a as any;
}

async function threadWithOneTurn(a: any): Promise<string> {
  const s = await request(a).post('/api/sessions').send({ provider: 'claude-code', workingDir: dir, name: 'p' });
  const t = await request(a).post(`/api/sessions/${s.body.id}/terminals`).send({ type: 'claude-code', config: { transport: 'structured' } });
  const id = t.body.id as string;
  await until(() => terminalsDb.getById(db, id)?.external_id === 'sess-fake');
  await request(a).post(`/api/terminals/${id}/message`).send({ text: 'first', source: 'user' }).expect(204);
  await until(() => (a._structuredManager.getEvents(id) as any[]).some((e) => e.type === 'result'));
  await until(() => !['working', 'starting'].includes(terminalsDb.getById(db, id)!.status));
  return id;
}

describe('idle thread processes on a host that turns the reaper on', () => {
  it('stops an idle process, keeps the status, does not wake on view, and resumes on the next message', async () => {
    const a = app({ DISPATCH_IDLE_PROCESS_MINUTES: '15' });
    const reaper = a._processReaper;
    expect(reaper).not.toBeNull();
    const mgr = a._structuredManager;
    const id = await threadWithOneTurn(a);
    const statusBefore = terminalsDb.getById(db, id)!.status;

    now += 14 * 60_000;
    reaper.tick();
    expect(mgr.isAlive(id)).toBe(true); // not before the timeout
    now += 2 * 60_000;
    reaper.tick();
    expect(mgr.isAlive(id)).toBe(false);
    expect(isDormantStop(id)).toBe(true);
    await sleep(50); // the deferred status work after the exit
    const row = terminalsDb.getById(db, id)!;
    expect(row.status).toBe(statusBefore); // the person sees no change
    expect(row.pid).toBeNull();
    expect(JSON.parse(row.config ?? '{}')[DORMANT_KEY]).toEqual(expect.any(String));

    // Viewing: the chat socket opens and replays, but no process starts and no "Process exited" frame comes.
    const frames: any[] = [];
    const ws = { readyState: 1, bufferedAmount: 0, send: (s: string) => frames.push(JSON.parse(s)), close: () => {}, on: () => {} } as any;
    handleStructuredConnection(ws, { url: `/api/terminals/${id}/structured-ws?journal=1` } as any, mgr, structuredViewOpener(a._sessionService));
    await sleep(100);
    expect(mgr.isAlive(id)).toBe(false);
    expect(frames.some((f) => f.subtype === 'process_exit')).toBe(false);
    await request(a).get(`/api/terminals/${id}/journal`).expect(200);
    expect(mgr.isAlive(id)).toBe(false);

    // The next message resumes the same conversation and the reply reaches the open socket.
    await request(a).post(`/api/terminals/${id}/message`).send({ text: 'second', source: 'user' }).expect(204);
    expect(mgr.isAlive(id)).toBe(true);
    expect(isDormantStop(id)).toBe(false);
    const init = await until(() => (mgr.getEvents(id) as any[]).find((e) => e.type === 'system' && Array.isArray(e.argv)));
    expect(init.argv).toEqual(expect.arrayContaining(['-r', 'sess-fake']));
    await until(() => frames.find((f) => f.type === 'assistant' && JSON.stringify(f).includes('echo:second')));
    expect(JSON.parse(terminalsDb.getById(db, id)!.config ?? '{}')[DORMANT_KEY]).toBeUndefined();

    // The journal: each message and each answer once, in order, no gap.
    await until(() => new MessageJournal(db).page(id, { limit: 100 }).items.filter((r) => r.kind === 'result').length === 2);
    const items = new MessageJournal(db).page(id, { limit: 100 }).items;
    const texts = items.map((r) => JSON.stringify(r.payload)).filter((p) => /first|second/.test(p));
    expect(texts.filter((p) => p.includes('echo:first'))).toHaveLength(1);
    expect(texts.filter((p) => p.includes('echo:second'))).toHaveLength(1);
    expect(items.map((r) => r.seq)).toEqual(items.map((_, i) => items[0].seq + i));
  });

  it('a restart keeps a dormant thread dormant: a new daemon on the same database does not start it on view', async () => {
    const a = app({ DISPATCH_IDLE_PROCESS_MINUTES: '1' });
    const id = await threadWithOneTurn(a);
    now += 2 * 60_000;
    a._processReaper.tick();
    expect(a._structuredManager.isAlive(id)).toBe(false);
    resetDormantStateForTest(); // the new daemon starts with no memory
    const b = app({ DISPATCH_IDLE_PROCESS_MINUTES: '1' });
    expect(structuredViewOpener(b._sessionService)(id)).toBe(false);
    expect(b._structuredManager.isAlive(id)).toBe(false);
  });
});

describe('a local install (no variables)', () => {
  it('wires no reaper, and opening a stopped thread starts it as before', async () => {
    const a = app({ DISPATCH_IDLE_PROCESS_MINUTES: '', DISPATCH_MAX_LIVE_PROCESSES: '' });
    expect(a._processReaper).toBeNull();
    const id = await threadWithOneTurn(a);
    a._structuredManager.kill(id); // as after a daemon restart
    expect(structuredViewOpener(a._sessionService)(id)).toBe(true);
    expect(a._structuredManager.isAlive(id)).toBe(true);
  });
});
