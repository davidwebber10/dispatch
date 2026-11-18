// Box defect #7 (2026-11-11): a hosted box signs its Codex CLI login in with the device code, not a terminal thread.
import { afterEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccountsRouter } from './accounts.js';
import { AccountsStore } from '../auth/accounts.js';

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

function app() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-hosted-'));
  const start = vi.fn(async (id: string, home: string) => ({ id: 'x', status: 'awaiting_code', url: 'https://auth.openai.com/codex/device', code: 'ABCD-1234', accountId: id, home }));
  const a = express();
  a.use(express.json());
  a.use('/api/accounts', createAccountsRouter(new AccountsStore(dir), {} as any, { codexLogin: { start, status: vi.fn(), cancel: vi.fn() } as any }));
  return { a, start };
}

describe('Codex CLI login on a hosted box', () => {
  test('local: refused (it signs in on its own computer)', async () => {
    delete process.env.OS_BASE_URL; delete process.env.OS_BOX_TOKEN;
    const { a, start } = app();
    expect((await request(a).post('/api/accounts/codex/cli/login')).status).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });
  test('hosted: the device code runs in the box\'s own CODEX_HOME', async () => {
    process.env.OS_BASE_URL = 'http://os'; process.env.OS_BOX_TOKEN = 't'; process.env.CODEX_HOME = '/home/dispatch/.codex';
    const { a, start } = app();
    const r = await request(a).post('/api/accounts/codex/cli/login');
    expect(r.status).toBe(200);
    expect(start).toHaveBeenCalledWith('cli', '/home/dispatch/.codex');
  });
});
