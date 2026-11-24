import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountsStore } from '../../src/auth/accounts.js';
import { createAccountsRouter } from '../../src/routes/accounts.js';

/**
 * A full sign-in for one Claude account on a local install (spec 2026-11-24): the account gets a login
 * folder of its own, so its threads keep the claude.ai connectors of that account.
 */
describe('accounts routes: a Claude account with its own login folder', () => {
  let dir: string;
  let store: AccountsStore;
  let starts: { label: string; accountId?: string; folder: boolean }[];
  let signedOut: string[];
  let order: string[];
  let folderStatus: Record<string, { loggedIn: boolean } | null>;

  const appWith = (o: { offers: boolean; clean?: boolean }) => {
    const login = {
      offersFolderLogin: o.offers,
      usesCleanLogin: o.clean === true,
      forgetSavedToken: () => {},
      startForAccount: async (label: string, accountId?: string, _base?: string, opts?: { folder?: boolean }) => {
        starts.push({ label, ...(accountId ? { accountId } : {}), folder: opts?.folder === true });
        return { id: 's1', status: 'awaiting_code', url: 'https://claude.com/x', error: null, createdAt: '' };
      },
      signOutAccountFolder: async (configDir: string) => { order.push('sign-out'); signedOut.push(configDir); },
      cliStatus: async (q: { configDir?: string | null }) => (q.configDir && q.configDir in folderStatus ? folderStatus[q.configDir] : null),
    };
    const app = express();
    app.use(express.json());
    app.use('/api/accounts', createAccountsRouter(store, login as never, {
      threads: { pinnedTo: () => [], unpin: () => { order.push('unpin'); return 0; } },
    }));
    return app;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-folder-'));
    store = new AccountsStore(dir);
    starts = []; signedOut = []; order = []; folderStatus = {};
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('the list says whether this install offers the full sign-in', async () => {
    expect((await request(appWith({ offers: true })).get('/api/accounts').expect(200)).body.claudeFullSignIn).toBe(true);
    expect((await request(appWith({ offers: false })).get('/api/accounts').expect(200)).body.claudeFullSignIn).toBe(false);
  });

  it('an account with a folder carries the sign-in state that Claude Code gives for that folder', async () => {
    const inDir = path.join(dir, 'claude-accounts', 'in');
    const outDir = path.join(dir, 'claude-accounts', 'out');
    const unknownDir = path.join(dir, 'claude-accounts', 'unknown');
    store.upsertClaudeConfigDir({ id: 'in', label: 'In', configDir: inDir });
    store.upsertClaudeConfigDir({ id: 'out', label: 'Out', configDir: outDir });
    store.upsertClaudeConfigDir({ id: 'unknown', label: 'Unknown', configDir: unknownDir });
    const saved = store.addClaude({ token: 'tok-w', label: 'Work' });
    folderStatus = { [inDir]: { loggedIn: true }, [outDir]: { loggedIn: false } };
    const list = (await request(appWith({ offers: true })).get('/api/accounts').expect(200)).body.claude as { id: string; kind: string; signedIn?: boolean }[];
    const of = (id: string) => list.find((a) => a.id === id)!;
    expect(of('in')).toMatchObject({ kind: 'folder', signedIn: true });
    expect(of('out')).toMatchObject({ kind: 'folder', signedIn: false });
    expect('signedIn' in of('unknown')).toBe(false);
    expect('signedIn' in of(saved.id)).toBe(false);
    // A hosted box keeps its list as it was: this state is for the local page.
    const hosted = (await request(appWith({ offers: false, clean: true })).get('/api/accounts').expect(200)).body.claude as { id: string }[];
    expect('signedIn' in hosted.find((a) => a.id === 'out')!).toBe(false);
  });

  it('a new account with kind "folder" starts the full sign-in; with no kind it starts the token sign-in', async () => {
    const app = appWith({ offers: true });
    await request(app).post('/api/accounts/claude/login').send({ label: 'Team', kind: 'folder' }).expect(200);
    await request(app).post('/api/accounts/claude/login').send({ label: 'Work' }).expect(200);
    expect(starts).toEqual([{ label: 'Team', folder: true }, { label: 'Work', folder: false }]);
  });

  it('"sign in again" follows the kind of the account, whatever the request says', async () => {
    const app = appWith({ offers: true });
    const folder = path.join(dir, 'claude-accounts', 'acct1');
    store.upsertClaudeConfigDir({ id: 'acct1', label: 'Team', configDir: folder });
    const saved = store.addClaude({ token: 'tok-w', label: 'Work' });
    await request(app).post('/api/accounts/claude/login').send({ label: 'Team', accountId: 'acct1' }).expect(200);
    await request(app).post('/api/accounts/claude/login').send({ label: 'Work', accountId: saved.id, kind: 'folder' }).expect(200);
    expect(starts).toEqual([{ label: 'Team', accountId: 'acct1', folder: true }, { label: 'Work', accountId: saved.id, folder: false }]);
  });

  it('refuses a full sign-in in plain words when this install does not offer it, and starts nothing', async () => {
    const r = await request(appWith({ offers: false })).post('/api/accounts/claude/login').send({ label: 'Team', kind: 'folder' }).expect(400);
    expect(r.body.error).toBe('This Dispatch cannot make a full sign-in.');
    expect(starts).toEqual([]);
  });

  it('a hosted box signs every account in with a folder already: the kind changes nothing there', async () => {
    const app = appWith({ offers: false, clean: true });
    await request(app).post('/api/accounts/claude/login').send({ label: 'Team', kind: 'folder' }).expect(200);
    expect(starts).toEqual([{ label: 'Team', folder: false }]);
  });

  it('removing an account with a folder signs the folder out first, then deletes it', async () => {
    const app = appWith({ offers: true });
    const folder = path.join(dir, 'claude-accounts', 'acct1');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, '.claude.json'), '{}');
    store.upsertClaudeConfigDir({ id: 'acct1', label: 'Team', configDir: folder });
    await request(app).delete('/api/accounts/claude/acct1').expect(200);
    expect(signedOut).toEqual([folder]);
    expect(order).toEqual(['sign-out', 'unpin']);
    expect(fs.existsSync(folder)).toBe(false);
    expect(store.has('claude', 'acct1')).toBe(false);
  });

  it('a folder that Claude Code could not sign out keeps its account and its folder, and the answer says why', async () => {
    const folder = path.join(dir, 'claude-accounts', 'acct1');
    fs.mkdirSync(folder, { recursive: true });
    store.upsertClaudeConfigDir({ id: 'acct1', label: 'Team', configDir: folder });
    const app = express();
    app.use(express.json());
    app.use('/api/accounts', createAccountsRouter(store, {
      offersFolderLogin: true, usesCleanLogin: false, forgetSavedToken: () => {},
      signOutAccountFolder: async () => { throw new Error('Claude Code could not sign this account out.'); },
    } as never, { threads: { pinnedTo: () => [], unpin: () => { order.push('unpin'); return 0; } } }));
    const r = await request(app).delete('/api/accounts/claude/acct1').expect(500);
    expect(r.body.error).toBe('The account was not removed. Claude Code could not sign this account out.');
    expect(store.has('claude', 'acct1')).toBe(true);
    expect(fs.existsSync(folder)).toBe(true);
    expect(order).toEqual([]);
  });

  it('removing an account with a saved token signs no folder out', async () => {
    const app = appWith({ offers: true });
    const saved = store.addClaude({ token: 'tok-w', label: 'Work' });
    await request(app).delete(`/api/accounts/claude/${saved.id}`).expect(200);
    expect(signedOut).toEqual([]);
  });
});
