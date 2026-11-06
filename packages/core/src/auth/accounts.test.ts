import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountsStore, CLI_ACCOUNT_ID } from './accounts.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('AccountsStore', () => {
  it('starts with the CLI login as the only account of each harness, and as the default', () => {
    const a = new AccountsStore(dir);
    const v = a.view();
    expect(v.claude.map((x) => x.id)).toEqual([CLI_ACCOUNT_ID]);
    expect(v.codex.map((x) => x.id)).toEqual([CLI_ACCOUNT_ID]);
    expect(v.defaults).toEqual({ claude: 'cli', codex: 'cli' });
    expect(a.spawnEnv('claude-code', {})).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: '' });
    expect(a.spawnEnv('codex', {})).toEqual({});
    expect(a.spawnEnv('shell', {})).toEqual({});
  });

  it('migrates the single saved Claude login once, as the default; the token never appears in the view', () => {
    const a = new AccountsStore(dir);
    a.migrateSavedClaudeToken('tok-1');
    a.migrateSavedClaudeToken('tok-1');
    expect(a.view().claude.map((x) => x.id)).toEqual(['cli', 'saved']);
    expect(a.defaultId('claude')).toBe('saved');
    expect(JSON.stringify(a.view())).not.toContain('tok-1');
    expect(a.claudeToken('saved')).toBe('tok-1');
    // A thread with no account of its own runs on the default; one that names `cli` clears the token.
    expect(a.spawnEnv('claude-code', {})).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-1' });
    expect(a.spawnEnv('claude-code', { accountId: 'cli' })).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: '' });
    // The file is private.
    expect(fs.statSync(path.join(dir, 'accounts.json')).mode & 0o777).toBe(0o600);
  });

  it('adds a Claude account, fills its profile, replaces the token of the same account, and removes it', () => {
    const a = new AccountsStore(dir);
    const x = a.addClaude({ token: 'tok-a', label: 'Work' });
    a.updateClaude(x.id, { email: 'me@work.com', accountUuid: 'u-1', plan: 'Max' });
    expect(a.view().claude[1]).toMatchObject({ id: x.id, label: 'Work', email: 'me@work.com', plan: 'Max', isCli: false });
    const again = a.addClaude({ token: 'tok-a2', accountUuid: 'u-1' });
    expect(again.id).toBe(x.id);
    expect(a.claudeToken(x.id)).toBe('tok-a2');
    expect(a.spawnEnv('claude-code', { accountId: x.id })).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-a2' });
    a.setDefault('claude', x.id);
    expect(a.defaultId('claude')).toBe(x.id);
    expect(a.remove('claude', x.id)).toBe(true);
    expect(a.defaultId('claude')).toBe('cli');
    expect(() => a.remove('claude', 'cli')).toThrow(/cannot be removed/);
    // The store survives a reload.
    expect(new AccountsStore(dir).view().claude).toHaveLength(1);
  });

  it('a Codex account is a folder used as CODEX_HOME, also for its sign-in thread; removing it deletes the folder', () => {
    const a = new AccountsStore(dir);
    const c = a.addCodex('Personal');
    expect(fs.statSync(c.dir).isDirectory()).toBe(true);
    expect(a.codexSignedIn(c.id)).toBe(false);
    fs.writeFileSync(path.join(c.dir, 'auth.json'), '{}');
    expect(a.codexSignedIn(c.id)).toBe(true);
    expect(a.spawnEnv('codex', { accountId: c.id })).toEqual({ CODEX_HOME: c.dir });
    expect(a.spawnEnv('shell', { signIn: 'codex', accountId: c.id })).toEqual({ CODEX_HOME: c.dir });
    expect(a.spawnEnv('codex', { accountId: 'nope' })).toEqual({}); // unknown → the default (cli)
    a.remove('codex', c.id);
    expect(fs.existsSync(c.dir)).toBe(false);
  });

  it('tells listeners about every change', () => {
    const a = new AccountsStore(dir);
    let n = 0;
    a.onChange(() => { n++; });
    a.addCodex('x');
    a.setDefault('codex', a.view().codex[1].id);
    expect(n).toBe(2);
  });
});
