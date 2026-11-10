// packages/core/tests/journal/restart.test.ts
// What the message journal keeps across a daemon restart (W3-D): the Idempotency-Key of a message
// POST. Two apps on one database file stand for the daemon before and after the restart.
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as sessionsDb from '../../src/db/sessions.js';
import { createApp } from '../../src/server.js';
import { setDurableIdempotencyStore } from '../../src/http/idempotency.js';
import { MessageJournal } from '../../src/journal/journal.js';
import { KeysManager } from '../routes/keys-manager.js';

const dirs: string[] = [];
afterEach(() => { setDurableIdempotencyStore(null); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function daemon(file: string) {
  const db = new Database(file);
  initSchema(db);
  const mgr = new KeysManager();
  const app = createApp({ db, skipPty: true, managers: new Map([['claude-code', mgr.asManager()]]) });
  return { db, mgr, app };
}

describe('a message POST with an Idempotency-Key, across a daemon restart', () => {
  it('two POSTs with one key deliver once, when the second comes after a new daemon on the same database', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3d-restart-'));
    dirs.push(dir);
    const file = path.join(dir, 'dispatch.db');
    const first = daemon(file);
    sessionsDb.create(first.db, { id: 'A', provider: 'claude-code', name: 'A', workingDir: dir });
    terminalsDb.create(first.db, { id: 't1', sessionId: 'A', type: 'claude-code', label: 't1', config: { transport: 'structured' } });
    const post = (app: any, key: string, text: string) => request(app).post('/api/terminals/t1/message').set('Idempotency-Key', key).send({ text, source: 'user' });

    expect((await post(first.app, 'key-1', 'hello')).status).toBe(204);
    expect(first.mgr.sentTo('t1')).toHaveLength(1);
    // The same daemon: the memory record answers, as before W3-D.
    expect((await post(first.app, 'key-1', 'hello')).body).toEqual({ duplicate: true });
    first.db.close();

    // The daemon starts again. The client did not read the first answer and sends the POST again.
    const second = daemon(file);
    const copy = await post(second.app, 'key-1', 'hello');
    expect(copy.status).toBe(200);
    expect(copy.body).toEqual({ duplicate: true });
    expect(second.mgr.sentTo('t1')).toHaveLength(0); // nothing is delivered a second time
    // Another key is a new message.
    expect((await post(second.app, 'key-2', 'again')).status).toBe(204);
    expect(second.mgr.sentTo('t1')).toHaveLength(1);
    expect(new MessageJournal(second.db).findKey('t1', 'key-1')).not.toBeNull();
    second.db.close();
  });

  it('a POST with no key delivers every time, before and after a restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3d-restart-'));
    dirs.push(dir);
    const file = path.join(dir, 'dispatch.db');
    const first = daemon(file);
    sessionsDb.create(first.db, { id: 'A', provider: 'claude-code', name: 'A', workingDir: dir });
    terminalsDb.create(first.db, { id: 't1', sessionId: 'A', type: 'claude-code', label: 't1', config: { transport: 'structured' } });
    const post = (app: any) => request(app).post('/api/terminals/t1/message').send({ text: 'hello', source: 'user' });
    expect((await post(first.app)).status).toBe(204);
    first.db.close();
    const second = daemon(file);
    expect((await post(second.app)).status).toBe(204);
    expect(second.mgr.sentTo('t1')).toHaveLength(1);
    expect(new MessageJournal(second.db).lastSeq('t1')).toBe(0); // no key, no record
    second.db.close();
  });
});
