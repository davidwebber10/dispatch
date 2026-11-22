// A signed-out Claude thread through the daemon's own wiring, with a fake `claude` child process: the failed
// turn leaves the process alone (the chat keeps its sign-in card), and the next message replaces it with a
// process that resumes the saved session (`-r`) and answers, with no "Process exited" line between.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { handleStructuredConnection } from '../../src/ws/structured.js';
import { structuredViewOpener } from '../../src/daemon/sockets.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), '../structured/fake-claude.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | null | false, ms = 8000): Promise<T> {
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
const apps: any[] = [];
beforeEach(() => { db = new Database(':memory:'); initSchema(db); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-stop-e2e-')); });
afterEach(() => { for (const a of apps.splice(0)) { try { a._structuredManager?.killAll?.(); } catch { /* best effort */ } } fs.rmSync(dir, { recursive: true, force: true }); });

describe('a Claude thread whose login fails, on a local install', () => {
  it('keeps its process and its card, and the next message resumes the session in a new process', async () => {
    const a = createApp({ db, skipPty: true, structuredCommand: { command: process.execPath, args: [fake] } }) as any;
    apps.push(a);
    const mgr = a._structuredManager;
    const s = await request(a).post('/api/sessions').send({ provider: 'claude-code', workingDir: dir, name: 'p' });
    const t = await request(a).post(`/api/sessions/${s.body.id}/terminals`).send({ type: 'claude-code', config: { transport: 'structured' } });
    const id = t.body.id as string;
    await until(() => terminalsDb.getById(db, id)?.external_id === 'sess-fake');

    // A chat is open on the thread.
    const frames: any[] = [];
    const ws = { readyState: 1, bufferedAmount: 0, send: (x: string) => frames.push(JSON.parse(x)), close: () => {}, on: () => {} } as any;
    handleStructuredConnection(ws, { url: `/api/terminals/${id}/structured-ws` } as any, mgr, structuredViewOpener(a._sessionService));

    await request(a).post(`/api/terminals/${id}/message`).send({ text: 'TRIGGER_AUTH_FAIL', source: 'user' }).expect(204);
    await until(() => frames.some((f) => f.type === 'system' && f.subtype === 'auth_required'));
    await until(() => (mgr.getEvents(id) as any[]).some((e) => e.type === 'result' && e.is_error === true));
    await sleep(300);
    // The process stays: the chat keeps its card, and opening the thread starts nothing.
    expect(mgr.isAlive(id)).toBe(true);
    expect(terminalsDb.getById(db, id)!.status).not.toBe('done');
    expect(frames.some((f) => f.subtype === 'process_exit')).toBe(false);
    const pidBefore = terminalsDb.getById(db, id)!.pid;
    const initsBefore = (mgr.getEvents(id) as any[]).filter((e) => e.type === 'system' && e.subtype === 'init').length;

    // The person signs in again and writes to the same thread.
    await request(a).post(`/api/terminals/${id}/message`).send({ text: 'second', source: 'user' }).expect(204);
    expect(mgr.isAlive(id)).toBe(true);
    expect(terminalsDb.getById(db, id)!.pid).not.toBe(pidBefore); // a NEW process
    const init = await until(() => (mgr.getEvents(id) as any[]).filter((e) => e.type === 'system' && Array.isArray(e.argv)).pop());
    expect(init.argv).toEqual(expect.arrayContaining(['-r', 'sess-fake']));
    expect(initsBefore).toBeGreaterThan(0);
    expect(frames.some((f) => f.subtype === 'process_exit')).toBe(false); // the replaced process left no row
    await until(() => frames.find((f) => f.type === 'assistant' && JSON.stringify(f).includes('echo:second')));
    await until(() => terminalsDb.getById(db, id)!.status !== 'error');
  });
});
