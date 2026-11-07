import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as sessionsDb from '../../src/db/sessions.js';
import { AccountsStore } from '../../src/auth/accounts.js';
import { createAccountsRouter, type PinnedThread } from '../../src/routes/accounts.js';
import type { CodexLoginSession } from '../../src/auth/codex-login.js';

/** The accounts routes (multi-account): names, identities and the delete notice's thread list. */
describe('accounts routes', () => {
  let dir: string;
  let store: AccountsStore;
  let app: express.Express;
  let pinned: Record<string, PinnedThread[]>;
  let unpinned: string[];
  let profileCalls: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-routes-'));
    store = new AccountsStore(dir);
    pinned = {};
    unpinned = [];
    profileCalls = [];
    app = express();
    app.use(express.json());
    app.use('/api/accounts', createAccountsRouter(store, {} as any, {
      claudeProfile: async (id) => { profileCalls.push(id); return id === 'cli' ? { email: 'cli@x.y', plan: 'Max' } : null; },
      threads: {
        pinnedTo: (provider, id) => pinned[`${provider}:${id}`] ?? [],
        unpin: (provider, id) => { unpinned.push(`${provider}:${id}`); return (pinned[`${provider}:${id}`] ?? []).length; },
      },
    }));
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('lists accounts with the Claude profile email/plan (cached) and the pinned-thread count', async () => {
    const w = store.addClaude({ token: 'tok-w', label: 'Work' });
    pinned[`claude:${w.id}`] = [{ id: 't1', label: 'Fix login', sessionId: 's1' }];
    const r = await request(app).get('/api/accounts').expect(200);
    const cli = r.body.claude.find((a: any) => a.id === 'cli');
    expect(cli).toMatchObject({ email: 'cli@x.y', plan: 'Max', threadCount: 0 });
    expect(r.body.claude.find((a: any) => a.id === w.id)).toMatchObject({ label: 'Work', threadCount: 1 });
    expect(JSON.stringify(r.body)).not.toContain('tok-w');
    await request(app).get('/api/accounts').expect(200);
    expect(profileCalls.filter((x) => x === 'cli')).toHaveLength(1); // cached
  });

  it('renames an account, lists its threads, and removing it unpins them', async () => {
    const w = store.addClaude({ token: 'tok-w', label: 'Work' });
    await request(app).patch(`/api/accounts/claude/${w.id}`).send({ label: 'Side' }).expect(200);
    await request(app).patch('/api/accounts/claude/cli').send({ label: 'Laptop' }).expect(200);
    expect(store.view().claude.map((a) => a.label)).toEqual(['Laptop', 'Side']);
    await request(app).patch('/api/accounts/claude/nope').send({ label: 'x' }).expect(404);
    await request(app).patch(`/api/accounts/claude/${w.id}`).send({ label: '' }).expect(400);
    pinned[`claude:${w.id}`] = [{ id: 't1', label: 'Fix login', sessionId: 's1' }, { id: 't2', label: 'Docs', sessionId: 's1' }];
    const list = await request(app).get(`/api/accounts/claude/${w.id}/threads`).expect(200);
    expect(list.body.map((t: any) => t.label)).toEqual(['Fix login', 'Docs']);
    const del = await request(app).delete(`/api/accounts/claude/${w.id}`).expect(200);
    expect(del.body).toEqual({ unpinned: 2 });
    expect(unpinned).toEqual([`claude:${w.id}`]);
    expect(store.has('claude', w.id)).toBe(false);
  });
});

/** Sign a Codex account in (again) with the device-code flow (2026-11-07). */
describe('codex account sign-in routes', () => {
  let dir: string;
  let store: AccountsStore;
  let app: express.Express;
  let starts: { id: string; home: string }[];
  let cancels: string[];
  let sessions: Record<string, CodexLoginSession>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-codex-login-'));
    store = new AccountsStore(dir);
    starts = []; cancels = []; sessions = {};
    const codexLogin = {
      start: async (id: string, home: string) => {
        starts.push({ id, home });
        sessions[id] = { accountId: id, status: 'awaiting_user', url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345', error: null, createdAt: 'now' };
        return sessions[id];
      },
      status: (id: string) => sessions[id] ?? null,
      cancel: (id: string) => { cancels.push(id); delete sessions[id]; },
    };
    app = express();
    app.use(express.json());
    app.use('/api/accounts', createAccountsRouter(store, {} as any, { codexLogin: codexLogin as any }));
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('starts the device-code login in the account folder and returns the link and code', async () => {
    const a = store.addCodex('Work');
    const r = await request(app).post(`/api/accounts/codex/${a.id}/login`).expect(200);
    expect(r.body).toMatchObject({ status: 'awaiting_user', url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345' });
    expect(starts).toEqual([{ id: a.id, home: a.dir }]);
  });

  it('reports the attempt, and with none: complete once auth.json exists, else idle', async () => {
    const a = store.addCodex('Work');
    expect((await request(app).get(`/api/accounts/codex/${a.id}/login`).expect(200)).body.status).toBe('idle');
    await request(app).post(`/api/accounts/codex/${a.id}/login`).expect(200);
    expect((await request(app).get(`/api/accounts/codex/${a.id}/login`).expect(200)).body.code).toBe('ABCD-12345');
    await request(app).delete(`/api/accounts/codex/${a.id}/login`).expect(204);
    expect(cancels).toEqual([a.id]);
    fs.writeFileSync(path.join(a.dir, 'auth.json'), '{}');
    expect((await request(app).get(`/api/accounts/codex/${a.id}/login`).expect(200)).body.status).toBe('complete');
  });

  it('refuses the CLI login and unknown accounts', async () => {
    await request(app).post('/api/accounts/codex/cli/login').expect(400);
    await request(app).post('/api/accounts/codex/nope/login').expect(404);
    expect(starts).toEqual([]);
  });
});

describe('terminalsDb.listPinnedToAccount', () => {
  it('finds the live threads of a type pinned to the account, not archived ones or other types', () => {
    const db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp', skipPermissions: false } as any);
    terminalsDb.create(db, { id: 'a', sessionId: 's1', type: 'claude-code', label: 'A', skipPermissions: true, config: { accountId: 'work' } });
    terminalsDb.create(db, { id: 'b', sessionId: 's1', type: 'claude-code', label: 'B', skipPermissions: true, config: { accountId: 'work' } });
    terminalsDb.create(db, { id: 'c', sessionId: 's1', type: 'codex', label: 'C', skipPermissions: true, config: { accountId: 'work' } });
    terminalsDb.create(db, { id: 'd', sessionId: 's1', type: 'claude-code', label: 'D', skipPermissions: true, config: {} });
    db.prepare(`UPDATE terminals SET archived_at = '2026-11-06' WHERE id = 'b'`).run();
    expect(terminalsDb.listPinnedToAccount(db, 'claude-code', 'work').map((t) => t.id)).toEqual(['a']);
    expect(terminalsDb.listPinnedToAccount(db, 'codex', 'work').map((t) => t.id)).toEqual(['c']);
  });
});
