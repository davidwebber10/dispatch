import { describe, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCliLogin, extractLoginUrl, parseAuthStatus, MSG, INVALID_CODE_TEXT } from './claude-cli-login.js';
import { prepareAccountConfigDir } from './claude-config-dirs.js';
import { ClaudeLoginService } from './claude-login.js';
import { wireStopOnAuthFailure } from '../os/auth-stop.js';

const PRINTED = "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&state=xyz&login_hint=p%40example.com\n";
const LOCALHOST = 'https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&state=xyz';

/** A scripted `claude auth login`: what it prints, and what it does with each stdin line. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  lines: string[] = [];
  killed = false;
  stdin: Writable;
  constructor(onLine: (line: string, c: FakeChild) => void) {
    super();
    this.stdin = new Writable({ write: (chunk, _e, cb) => { const l = chunk.toString(); this.lines.push(l); onLine(l, this); cb(); } });
  }
  exit(code: number) { setTimeout(() => this.emit('exit', code), 1); }
  kill() { this.killed = true; this.exit(143); return true; }
}

function harness(onLine: (line: string, c: FakeChild) => void, status = '{"loggedIn":true,"authMethod":"claude.ai","email":"p@example.com","subscriptionType":"max","planTier":"max"}') {
  const children: FakeChild[] = [];
  const calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const spawn = vi.fn((cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    calls.push({ cmd, args, env: opts.env });
    const c = new FakeChild(onLine);
    children.push(c);
    setTimeout(() => { c.stdout.write(PRINTED); c.stdout.write('Paste code here if prompted > '); }, 2);
    return c as any;
  });
  const exec = vi.fn(async (_c: string, args: string[]) => ({ stdout: args.join(' ') === 'auth status' ? status : '', code: 0 }));
  const login = new ClaudeCliLogin({ spawn, exec, env: () => ({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'sk-should-not-pass', ANTHROPIC_API_KEY: 'k' }), startTimeoutMs: 1000, exchangeTimeoutMs: 1000 });
  return { login, children, calls, exec };
}

describe('the clean Claude login (claude auth login over pipes)', () => {
  test('runs `claude auth login --claudeai --email <owner>` with no token in its env and shows the printed URL', async () => {
    const { login, calls } = harness(() => {});
    const s = await login.start({ email: 'p@example.com' });
    expect(calls[0].cmd).toBe('claude');
    expect(calls[0].args).toEqual(['auth', 'login', '--claudeai', '--email', 'p@example.com']);
    expect(calls[0].env.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
    expect(calls[0].env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(calls[0].env.BROWSER).toBe('true');
    expect(s.status).toBe('awaiting_code');
    expect(s.url).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true/);
    expect(s.url).toContain('platform.claude.com');
    login.cancel();
  });

  test('a start while waiting for the code is the same attempt (a page reload keeps the login)', async () => {
    const { login, children } = harness(() => {});
    const a = await login.start({ email: 'p@example.com' });
    const b = await login.start({ email: 'p@example.com' });
    expect(b.id).toBe(a.id);
    expect(children).toHaveLength(1);
    login.cancel();
  });

  test('extractLoginUrl skips the localhost redirect handed to BROWSER', () => {
    expect(extractLoginUrl(`${LOCALHOST}\n${PRINTED}`)).toContain('platform.claude.com');
    expect(extractLoginUrl(LOCALHOST)).toBeNull();
  });

  test('a code without # is refused in plain words and the login keeps waiting (nothing is written)', async () => {
    const { login, children } = harness(() => {});
    await login.start({});
    const s = await login.submitCode('abc123');
    expect(s.status).toBe('awaiting_code');
    expect(s.error).toBe(MSG.noHash);
    expect(children[0].lines).toEqual([]);
    login.cancel();
  });

  test("Claude's own \"Invalid code\" keeps the login waiting with the plain sentence", async () => {
    const { login } = harness((_l, c) => { c.stderr.write(INVALID_CODE_TEXT + '\n'); });
    await login.start({});
    const s = await login.submitCode('a#b');
    expect(s.status).toBe('awaiting_code');
    expect(s.error).toBe(MSG.noHash);
    login.cancel();
  });

  test('"Login failed: That code wasn\'t accepted" + exit 1 ends the attempt with a plain error', async () => {
    const { login, children } = harness((_l, c) => { c.stderr.write("Login failed: That code wasn't accepted. Please try again.\n"); c.exit(1); });
    await login.start({});
    const s = await login.submitCode(' code#state \n');
    expect(children[0].lines).toEqual(['code#state\n']);
    expect(s.status).toBe('error');
    expect(s.error).toBe(MSG.rejected);
    expect(login.status()?.status).toBe('error');
  });

  test('exit 0, then `claude auth status` says loggedIn: complete; onLoggedIn gets the status, never a token', async () => {
    const { login, exec } = harness((_l, c) => c.exit(0));
    const seen: unknown[] = [];
    login.onLoggedIn = (i) => { seen.push(i); };
    await login.start({ tag: 'primary' });
    const s = await login.submitCode('code#state');
    expect(s.status).toBe('complete');
    expect(exec).toHaveBeenCalledWith('claude', ['auth', 'status'], expect.anything());
    expect(seen).toEqual([{ configDir: null, tag: 'primary', status: expect.objectContaining({ loggedIn: true, email: 'p@example.com' }) }]);
  });

  test('exit 0 but status still logged out: an error, not a false success', async () => {
    const { login } = harness((_l, c) => c.exit(0), '{"loggedIn":false,"authMethod":"none"}');
    await login.start({});
    expect((await login.submitCode('c#s')).status).toBe('error');
  });

  test('a login nobody finishes is stopped and its child killed', async () => {
    const children: FakeChild[] = [];
    const login = new ClaudeCliLogin({
      spawn: (() => { const c = new FakeChild(() => {}); children.push(c); setTimeout(() => c.stdout.write(PRINTED), 1); return c as any; }) as any,
      exec: async () => ({ stdout: '', code: 1 }), sessionTimeoutMs: 30, startTimeoutMs: 500,
    });
    await login.start({});
    await new Promise((r) => setTimeout(r, 60));
    expect(children[0].killed).toBe(true);
    expect(login.status()?.error).toBe(MSG.timeout);
  });

  test('a child that exits before printing a URL is an error', async () => {
    const login = new ClaudeCliLogin({ spawn: (() => { const c = new FakeChild(() => {}); c.exit(1); return c as any; }) as any, exec: async () => ({ stdout: '', code: 1 }), startTimeoutMs: 500 });
    expect((await login.start({})).status).toBe('error');
  });

  test('parseAuthStatus reads both shapes', () => {
    expect(parseAuthStatus('{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}')).toEqual({ loggedIn: false, authMethod: 'none' });
    expect(parseAuthStatus('{"loggedIn":true,"email":"a@b.c","orgId":"o","orgName":"Org","subscriptionType":"max","planTier":"max","loginExpiresAt":"2027-01-01"}'))
      .toMatchObject({ loggedIn: true, email: 'a@b.c', orgName: 'Org', planTier: 'max' });
    expect(parseAuthStatus('garbage')).toBeNull();
  });
});

describe('ClaudeLoginService on the clean login', () => {
  test('holds and injects no token; isAuthenticated follows `claude auth status`', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-clean-'));
    fs.writeFileSync(path.join(dir, 'claude-oauth-token'), 'sk-ant-oat01-old');
    const svc = new ClaudeLoginService(dir);
    const { login } = harness(() => {});
    svc.useCleanLogin(login, { ownerEmail: 'p@example.com' });
    expect(svc.getToken()).toBeNull();
    expect(svc.getSpawnEnv()).toEqual({});
    await svc.cliStatus({ fresh: true });
    expect(svc.isAuthenticated()).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('an added account gets its own config dir with projects/ shared, and is reported on success', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-acct-'));
    const primary = path.join(dir, 'primary');
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = primary;
    try {
      const svc = new ClaudeLoginService(dir);
      const { login, calls } = harness((_l, c) => c.exit(0));
      svc.useCleanLogin(login);
      const got: any[] = [];
      svc.onAccountConfigDir = (i) => { got.push(i); };
      await svc.startForAccount('Work', 'acct1');
      expect(calls[0].env.CLAUDE_CONFIG_DIR).toBe(path.join(dir, 'claude-accounts', 'acct1'));
      expect(calls[0].args).toEqual(['auth', 'login', '--claudeai']);
      expect(fs.readlinkSync(path.join(dir, 'claude-accounts', 'acct1', 'projects'))).toBe(path.join(primary, 'projects'));
      await svc.submitCode('c#s');
      expect(got[0]).toMatchObject({ id: 'acct1', label: 'Work', configDir: path.join(dir, 'claude-accounts', 'acct1') });
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('prepareAccountConfigDir never replaces a real folder and repairs a wrong link', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-prep-'));
    const primary = path.join(dir, 'p');
    fs.mkdirSync(path.join(dir, 'claude-accounts', 'x', 'skills'), { recursive: true });
    fs.symlinkSync('/nonexistent', path.join(dir, 'claude-accounts', 'x', 'projects'));
    prepareAccountConfigDir(dir, 'x', primary);
    expect(fs.lstatSync(path.join(dir, 'claude-accounts', 'x', 'skills')).isSymbolicLink()).toBe(false);
    expect(fs.readlinkSync(path.join(dir, 'claude-accounts', 'x', 'projects'))).toBe(path.join(primary, 'projects'));
    expect(() => prepareAccountConfigDir(dir, '../evil', primary)).toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('a signed-out thread stops its process (hosted)', () => {
  test('auth-required then idle: the thread is stopped once', async () => {
    const m = new EventEmitter() as any;
    const stop = vi.fn();
    const onAuthFailure = vi.fn();
    const off = wireStopOnAuthFailure({ managers: [m], stop, onAuthFailure, delayMs: 10_000 });
    m.emit('auth-required', 't1', {});
    m.emit('auth-required', 't1', {});
    m.emit('idle', 't1');
    await new Promise((r) => setImmediate(r));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith('t1');
    expect(onAuthFailure).toHaveBeenCalledTimes(2);
    m.emit('idle', 't2');
    expect(stop).toHaveBeenCalledTimes(1);
    off();
  });
});
