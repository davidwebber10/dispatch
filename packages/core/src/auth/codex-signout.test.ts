// codex-signout-v1: the person signs the box's own Codex login out. A working Codex thread refuses it in
// plain words; otherwise every Codex thread ends, `codex logout` runs in the login's folder, a file it
// leaves is removed by the agent, and the usage figures are forgotten.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signOutCodexCli, CODEX_BUSY_MESSAGE, type CodexSignOutDeps } from './codex-signout.js';
import { AccountsStore } from './accounts.js';
import { createAccountsRouter } from '../routes/accounts.js';

let home: string; let calls: string[];
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-signout-'));
  fs.writeFileSync(path.join(home, 'auth.json'), '{"tokens":{}}');
  calls = [];
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const deps = (over: Partial<CodexSignOutDeps> = {}): CodexSignOutDeps => ({
  home,
  env: () => ({ PATH: '/usr/bin' }),
  busyThread: () => null,
  stopThreads: () => { calls.push('stop'); },
  forgetUsage: () => { calls.push('forget'); },
  runLogout: async (env) => { calls.push(`logout ${env.CODEX_HOME}`); fs.rmSync(path.join(env.CODEX_HOME, 'auth.json'), { force: true }); },
  ...over,
});

describe('signOutCodexCli', () => {
  it('ends the threads, runs codex logout in the login folder, forgets the figures', async () => {
    expect(await signOutCodexCli(deps())).toEqual({ ok: true, signedIn: false });
    expect(calls).toEqual(['stop', `logout ${home}`, 'forget']);
    expect(fs.existsSync(path.join(home, 'auth.json'))).toBe(false);
  });

  it('a working Codex thread refuses it in plain words, and nothing is touched', async () => {
    expect(await signOutCodexCli(deps({ busyThread: () => 'Fix the report' }))).toEqual({ ok: false, status: 409, error: CODEX_BUSY_MESSAGE });
    expect(calls).toEqual([]);
    expect(fs.existsSync(path.join(home, 'auth.json'))).toBe(true);
  });

  it('a file codex logout leaves is removed by the agent; one that stays is a plain error', async () => {
    const removed: string[] = [];
    expect(await signOutCodexCli(deps({ runLogout: async () => {}, removeAuth: (h) => { removed.push(h); fs.rmSync(path.join(h, 'auth.json')); } }))).toEqual({ ok: true, signedIn: false });
    expect(removed).toEqual([home]);
    fs.writeFileSync(path.join(home, 'auth.json'), '{}');
    expect(await signOutCodexCli(deps({ runLogout: async () => {}, removeAuth: () => {} }))).toEqual({ ok: false, status: 500, error: 'Codex could not sign out. Try again.' });
  });
});

describe('DELETE /api/accounts/codex/cli', () => {
  const HOSTED = { OS_BASE_URL: 'https://os.example.com', OS_BOX_TOKEN: 'box-token-for-test' };
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of Object.keys(HOSTED)) saved[k] = process.env[k]; });
  afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const app = (signOut?: () => Promise<any>) => {
    const a = express(); a.use(express.json());
    a.use('/api/accounts', createAccountsRouter(new AccountsStore(home), {} as never, { ...(signOut ? { codexSignOut: signOut } : {}) }));
    return a;
  };

  it('hosted: signs out and answers the new state; a working thread is 409 with the plain message', async () => {
    Object.assign(process.env, HOSTED);
    expect((await request(app(async () => ({ ok: true, signedIn: false }))).delete('/api/accounts/codex/cli')).body).toEqual({ signedIn: false });
    const busy = await request(app(async () => ({ ok: false, status: 409, error: CODEX_BUSY_MESSAGE }))).delete('/api/accounts/codex/cli');
    expect([busy.status, busy.body]).toEqual([409, { error: CODEX_BUSY_MESSAGE }]);
  });

  it("a local install keeps the refusal: the login is its computer's", async () => {
    for (const k of Object.keys(HOSTED)) delete process.env[k];
    let called = false;
    const r = await request(app(async () => { called = true; return { ok: true, signedIn: false }; })).delete('/api/accounts/codex/cli');
    expect(r.status).toBe(400);
    expect(called).toBe(false);
  });
});
