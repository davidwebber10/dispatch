// Task 19: no thread key reaches the daemon log (console.log, console.warn, console.error).
// Each case makes the key appear in the place where a log line could pick it up, then reads every line.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as sessionsDb from '../../src/db/sessions.js';
import { createApp } from '../../src/server.js';
import { configureRefusalLog } from '../../src/auth/route-policy.js';
import { configurePairLimiter } from '../../src/auth/key-rules.js';
import { createNoCredentialStats } from '../../src/auth/no-credential-stats.js';
import type { StructuredSpawnOpts } from '../../src/structured/manager.js';
import { KeysManager } from '../routes/keys-manager.js';

/** A manager whose threads can be made dead, so the next message has to revive them. */
class LogManager extends KeysManager {
  up = false;
  override isAlive(): boolean { return this.up; }
  override spawn(id: string, opts: StructuredSpawnOpts): number { this.up = true; return super.spawn(id, opts); }
}

const KEY_IN_TEXT = /\b(dtk|dck|dsk)_[A-Za-z0-9_-]{43}/;

describe('no key in the daemon log', () => {
  let app: any;
  let db: Database.Database;
  let mgr: LogManager;
  let tmp: string;
  let lines: string[];
  const known = new Set<string>();

  const mint = (id: string) => { const k = app.locals.keys.mint({ kind: 'thread', terminalId: id }).key as string; known.add(k); return k; };
  const as = (key: string) => ({ Authorization: `Bearer ${key}` });
  const mk = (id: string, sessionId: string, config: Record<string, any> = {}) =>
    terminalsDb.create(db, { id, sessionId, type: 'claude-code', label: id, config: { transport: 'structured', ...config } });

  /** Every line must hold neither a key-shaped value nor any key that this test minted. */
  const expectClean = () => {
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(KEY_IN_TEXT);
      for (const k of known) expect(line).not.toContain(k);
    }
  };

  beforeEach(() => {
    lines = [];
    const take = (...args: unknown[]) => { lines.push(args.map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 6 }))).join(' ')); };
    vi.spyOn(console, 'log').mockImplementation(take);
    vi.spyOn(console, 'warn').mockImplementation(take);
    vi.spyOn(console, 'error').mockImplementation(take);
    configureRefusalLog(); // the default sink: console.log
    configurePairLimiter();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-log-'));
    tmp = fs.mkdtempSync(path.join(tmp, 'sb-'));
    db = new Database(':memory:');
    initSchema(db);
    mgr = new LogManager();
    app = createApp({ db, skipPty: true, managers: new Map([['claude-code', mgr.asManager()]]) });
    fs.mkdirSync(path.join(tmp, 'A'));
    sessionsDb.create(db, { id: 'A', provider: 'claude-code', name: 'proj-A', workingDir: path.join(tmp, 'A') });
    mk('coordA', 'A', { role: 'coordinator', spawnDepth: 0 });
    mk('wA', 'A', { role: 'agent', agentType: 'implementer', spawnedBy: 'coordA', spawnDepth: 1 });
    terminalsDb.updateSortOrder(db, 'coordA', 1);
    known.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    configureRefusalLog({ log: () => {} });
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  });

  const body = { type: 'claude-code', label: 'w', config: { transport: 'structured', agentType: 'implementer', role: 'agent', mission: 'm', spawnDepth: 1, spawnedBy: 'coordA' } };

  it('a spawn, a refused call and a revoked-key call write no key', async () => {
    const coord = mint('coordA');
    const created = await request(app).post('/api/sessions/A/terminals').set(as(coord)).send(body).expect(201);
    await request(app).post(`/api/terminals/${created.body.id}/message`).set(as(coord)).send({ text: 'start' }).expect(204);
    // The new thread holds its key in the spawn env, and only there.
    const spawnedEnv = mgr.spawned.find((s) => s.id === created.body.id)!.opts.env as Record<string, string>;
    expect(spawnedEnv.DISPATCH_AUTH).toMatch(KEY_IN_TEXT);
    known.add(spawnedEnv.DISPATCH_AUTH);

    const worker = mint('wA');
    const refused = await request(app).post('/api/secrets').set(as(worker)).send({ name: 'X', value: 'y' });
    expect(refused.body.error).toBe('owner_only');
    const forged = await request(app).post('/api/terminals/wA/message').set(as(worker)).send({ text: 'x', source: 'user' });
    expect(forged.status).toBe(403);

    // A revoked key, and a key written into the URL of the call.
    app.locals.keys.revoke(app.locals.keys.liveHandleFor('wA'));
    const revoked = await request(app).get('/api/terminals/coordA').set(as(worker));
    expect(revoked.status).toBe(401);
    // Each revoked key logs its own first line, so the key in the URL cannot hide behind the rate limit.
    const stale = mint('coordA');
    const stale2 = mint('wA');
    app.locals.keys.revoke(app.locals.keys.liveHandleFor('coordA'));
    app.locals.keys.revoke(app.locals.keys.liveHandleFor('wA'));
    const inPath = await request(app).get(`/api/terminals/${worker}`).set(as(stale));
    expect(inPath.status).toBe(401);
    const loginPath = await request(app).post(`/api/access/login/${worker}`).set(as(stale2)).send({});
    expect(loginPath.status).toBe(401);
    expectClean();
    expect(lines.some((l) => l.startsWith('[keys] refused'))).toBe(true);
  });

  it('a stats summary writes no key, even when a request path holds one', () => {
    let clock = 1_000_000;
    const key = 'dtk_' + 'AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQ'.slice(0, 43); // no digit
    expect(key).toHaveLength(47);
    known.add(key);
    const stats = createNoCredentialStats({ now: () => clock });
    const req = (p: string) => ({ method: 'GET', path: p, headers: { 'user-agent': `curl ${key}` } as any });
    stats.record(req(`/api/terminals/${key}`));
    stats.record(req(`/api/terminals/${key}/conversation`));
    clock += 61 * 60_000;
    stats.record(req(`/api/watches/${key}`));
    expect(lines.some((l) => l.includes('summary'))).toBe(true);
    expectClean();
  });

  it('a structured exit with stderr, and a spawn that fails, write no key', async () => {
    const coord = mint('coordA');
    const created = await request(app).post('/api/sessions/A/terminals').set(as(coord)).send(body).expect(201);
    await request(app).post(`/api/terminals/${created.body.id}/message`).set(as(coord)).send({ text: 'start' }).expect(204);
    const env = mgr.spawned.find((s) => s.id === created.body.id)!.opts.env as Record<string, string>;
    known.add(env.DISPATCH_AUTH);
    // The CLI dies and its stderr tail holds its own environment, key included.
    mgr.emit('exit', created.body.id, 1, `fatal: DISPATCH_AUTH=${env.DISPATCH_AUTH} was rejected`);
    // The next message revives a dead thread; this time the spawn itself throws, with the key in its message.
    mgr.up = false;
    vi.spyOn(mgr, 'spawn').mockImplementation((id, opts) => {
      known.add(String((opts.env as Record<string, string>).DISPATCH_AUTH));
      throw new Error(`spawn failed with DISPATCH_AUTH=${(opts.env as Record<string, string>).DISPATCH_AUTH}`);
    });
    await request(app).post(`/api/terminals/${created.body.id}/message`).set(as(coord)).send({ text: 'wake up' });
    expectClean();
    expect(lines.some((l) => l.includes('could not start'))).toBe(true);
  });
});
