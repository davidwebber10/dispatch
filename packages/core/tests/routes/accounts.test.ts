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
