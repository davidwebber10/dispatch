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

// Found with a real sign-in on 2026-11-24 (Claude Code 2.1.331): the failure line now starts with
// "Couldn't log in:", and a failure that is not about the code was shown as "did not accept that code".
describe('the reason of a failed sign-in is the one Claude Code gives', () => {
  test('"Couldn\'t log in: That code wasn\'t accepted…" is the plain "not accepted" sentence', async () => {
    const { login } = harness((_l, c) => { c.stderr.write("Couldn't log in: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.\n"); c.exit(1); });
    await login.start({});
    const s = await login.submitCode('c#s');
    expect(s).toMatchObject({ status: 'error', error: MSG.rejected });
  });

  test('"Couldn\'t log in:" with another reason shows that reason, not "the code was not accepted"', async () => {
    const { login } = harness((_l, c) => { c.stderr.write("Couldn't log in: A keychain cannot be found to store the login.\n"); c.exit(1); });
    await login.start({});
    const s = await login.submitCode('c#s');
    expect(s.status).toBe('error');
    expect(s.error).toBe(`${MSG.failedWith} A keychain cannot be found to store the login. Start it again.`);
  });

  test('words on stderr that are not a failure line we know are never shown: the fixed sentence stays, as before', async () => {
    const a = harness((_l, c) => { c.stderr.write('some warning\n    at exchange (file:///opt/cli.js:1:1)\nab#cd\n'); c.exit(1); });
    await a.login.start({});
    expect((await a.login.submitCode('ab#cd')).error).toBe(MSG.rejected);
    const b = harness((_l, c) => c.exit(1));
    await b.login.start({});
    expect((await b.login.submitCode('c#s')).error).toBe(MSG.rejected);
  });

  test('a failure line that repeats the pasted code never shows it, whole or in halves', async () => {
    const { login } = harness((_l, c) => { c.stderr.write("Couldn't log in: the code ab12#cd34 (ab12, cd34) could not be exchanged.\n"); c.exit(1); });
    await login.start({});
    const s = await login.submitCode('ab12#cd34');
    expect(s.error).toContain(MSG.failedWith);
    expect(s.error).not.toContain('ab12');
    expect(s.error).not.toContain('cd34');
  });
});

// A full sign-in for ONE account on a local install (spec 2026-11-24): the token sign-in stays the
// default path, and an account can instead get its own login folder, which keeps the claude.ai
// connectors of that account.
describe('ClaudeLoginService: a full sign-in for one account on a local install', () => {
  /** A `claude setup-token` terminal that prints a link at once. */
  function tokenPty() {
    const em = new EventEmitter();
    let killed = false;
    const written: string[] = [];
    const proc: any = {
      onData: (cb: (d: string) => void) => { em.on('data', cb); setTimeout(() => em.emit('data', 'https://claude.com/cai/oauth/authorize?code=true&client_id=x\n'), 2); },
      onExit: (cb: () => void) => em.on('exit', cb),
      write: (d: string) => { written.push(d); },
      kill: () => { killed = true; em.emit('exit'); },
    };
    return { spawn: (() => proc) as any, written, get killed() { return killed; } };
  }
  const withPrimary = async (fn: (dir: string, primary: string) => Promise<void>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-folder-'));
    const primary = path.join(dir, 'primary');
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = primary;
    try { await fn(dir, primary); } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  test('it runs `claude auth login` in the account folder, reports the account, and leaves the token login as it was', () => withPrimary(async (dir, primary) => {
    fs.writeFileSync(path.join(dir, 'claude-oauth-token'), 'sk-ant-oat01-old');
    const svc = new ClaudeLoginService(dir, tokenPty().spawn);
    const { login, calls } = harness((_l, c) => c.exit(0));
    svc.useFolderLogin(login);
    expect(svc.usesCleanLogin).toBe(false);
    expect(svc.offersFolderLogin).toBe(true);
    const got: any[] = [];
    svc.onAccountConfigDir = (i) => { got.push(i); };
    const s = await svc.startForAccount('Team', undefined, undefined, { folder: true });
    expect(s.status).toBe('awaiting_code');
    const folder = calls[0].env.CLAUDE_CONFIG_DIR!;
    expect(path.dirname(folder)).toBe(path.join(dir, 'claude-accounts'));
    expect(calls[0].args).toEqual(['auth', 'login', '--claudeai']);
    expect(calls[0].env.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
    expect(fs.readlinkSync(path.join(folder, 'projects'))).toBe(path.join(primary, 'projects'));
    // The code and the status of this attempt go to the folder sign-in.
    expect(svc.status()?.id).toBe(s.id);
    const done = await svc.submitCode('c#s');
    expect(done.status).toBe('complete');
    expect(svc.status()?.status).toBe('complete');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ label: 'Team', configDir: folder });
    expect(got[0].id).toBe(path.basename(folder));
    // The token login of the install is not touched.
    expect(svc.getToken()).toBe('sk-ant-oat01-old');
    expect(svc.isAuthenticated()).toBe(true);
  }));

  test('"sign in again" for an account that has a folder uses the same folder', () => withPrimary(async (dir) => {
    const svc = new ClaudeLoginService(dir, tokenPty().spawn);
    const { login, calls } = harness(() => {});
    svc.useFolderLogin(login);
    await svc.startForAccount('Team', 'acct1', undefined, { folder: true });
    expect(calls[0].env.CLAUDE_CONFIG_DIR).toBe(path.join(dir, 'claude-accounts', 'acct1'));
    svc.cancel();
  }));

  test('one sign-in at a time: a token sign-in ends the folder one, and a folder sign-in ends the token one', () => withPrimary(async (dir) => {
    const pty = tokenPty();
    const svc = new ClaudeLoginService(dir, pty.spawn);
    const { login, children } = harness(() => {});
    svc.useFolderLogin(login);
    await svc.startForAccount('Team', 'acct1', undefined, { folder: true });
    const token = await svc.startForAccount('Work');
    expect(children[0].killed).toBe(true);
    expect(svc.status()?.id).toBe(token.id);
    const folder = await svc.startForAccount('Team', 'acct1', undefined, { folder: true });
    expect(pty.killed).toBe(true);
    expect(svc.status()?.id).toBe(folder.id);
    svc.cancel();
    expect(svc.status()).toBeNull();
    expect(children[1].killed).toBe(true);
  }));

  test('the sign-in state of a folder comes from Claude Code; the login of the computer is not asked here', () => withPrimary(async (dir) => {
    const svc = new ClaudeLoginService(dir, tokenPty().spawn);
    const { login, exec } = harness(() => {});
    svc.useFolderLogin(login);
    const st = await svc.cliStatus({ configDir: path.join(dir, 'claude-accounts', 'acct1'), fresh: true });
    expect(st?.loggedIn).toBe(true);
    expect((exec.mock.calls[0] as any)[2].env.CLAUDE_CONFIG_DIR).toBe(path.join(dir, 'claude-accounts', 'acct1'));
    expect(await svc.cliStatus()).toBeNull();
    expect(exec).toHaveBeenCalledTimes(1);
  }));

  test('removing the account signs its folder out with Claude Code (the credential can be in the keychain)', () => withPrimary(async (dir) => {
    const svc = new ClaudeLoginService(dir, tokenPty().spawn);
    const { login, exec } = harness(() => {}, '{"loggedIn":false}');
    svc.useFolderLogin(login);
    const folder = path.join(dir, 'claude-accounts', 'acct1');
    await svc.signOutAccountFolder(folder);
    const call = exec.mock.calls.find((c: any) => c[1].join(' ') === 'auth logout') as any;
    expect(call[2].env.CLAUDE_CONFIG_DIR).toBe(folder);
  }));

  test('a sign-in for a NEW account that fails or is cancelled leaves no folder behind', () => withPrimary(async (dir) => {
    const svc = new ClaudeLoginService(dir, tokenPty().spawn);
    const failing = harness((_l, c) => { c.stderr.write("Couldn't log in: That code wasn't accepted.\n"); c.exit(1); });
    svc.useFolderLogin(failing.login);
    const root = path.join(dir, 'claude-accounts');
    await svc.startForAccount('Team', undefined, undefined, { folder: true });
    expect(fs.readdirSync(root)).toHaveLength(1);
    expect((await svc.submitCode('c#s')).status).toBe('error');
    expect(fs.readdirSync(root)).toHaveLength(0);
    // Cancelled while it waits for the code.
    await svc.startForAccount('Team', undefined, undefined, { folder: true });
    expect(fs.readdirSync(root)).toHaveLength(1);
    svc.cancel();
    expect(fs.readdirSync(root)).toHaveLength(0);
    // Replaced by another sign-in.
    await svc.startForAccount('Team', undefined, undefined, { folder: true });
    await svc.startForAccount('Work');
    expect(fs.readdirSync(root)).toHaveLength(0);
    svc.cancel();
  }));

  test('the folder of an account that exists is never deleted by a failed "sign in again"; a new account that signed in keeps its folder', () => withPrimary(async (dir) => {
    const svc = new ClaudeLoginService(dir, tokenPty().spawn);
    const failing = harness((_l, c) => { c.stderr.write("Couldn't log in: That code wasn't accepted.\n"); c.exit(1); });
    svc.useFolderLogin(failing.login);
    const root = path.join(dir, 'claude-accounts');
    await svc.startForAccount('Team', 'acct1', undefined, { folder: true });
    await svc.submitCode('c#s');
    expect(fs.readdirSync(root)).toEqual(['acct1']);
    const ok = harness((_l, c) => c.exit(0));
    svc.useFolderLogin(ok.login);
    await svc.startForAccount('New', undefined, undefined, { folder: true });
    await svc.submitCode('c#s');
    svc.cancel(); // a later cancel must not touch the folder of the account that now exists
    expect(fs.readdirSync(root)).toHaveLength(2);
  }));

  // Review of #193: cleanup and completion belong to ONE attempt.
  test('a start that was replaced before its link came does not delete the folder of the attempt that replaced it', () => withPrimary(async (dir) => {
    const svc = new ClaudeLoginService(dir, tokenPty().spawn);
    let n = 0;
    const children: FakeChild[] = [];
    const login = new ClaudeCliLogin({
      spawn: ((_cmd: string, _args: string[]) => {
        const c = new FakeChild(() => {});
        children.push(c);
        if (n++ > 0) setTimeout(() => { c.stdout.write(PRINTED); }, 2); // the first one never prints its link
        return c as any;
      }) as any,
      exec: async () => ({ stdout: '{"loggedIn":false}', code: 0 }), env: () => ({ PATH: '/bin' }), startTimeoutMs: 2000, exchangeTimeoutMs: 1000,
    });
    svc.useFolderLogin(login);
    const root = path.join(dir, 'claude-accounts');
    const first = svc.startForAccount('A', undefined, undefined, { folder: true });
    await new Promise((r) => setTimeout(r, 20));
    const second = await svc.startForAccount('B', undefined, undefined, { folder: true });
    expect(second.status).toBe('awaiting_code');
    expect((await first).status).toBe('error');
    expect(fs.readdirSync(root)).toHaveLength(1); // B's folder; A's is gone
    expect(svc.status()?.id).toBe(second.id);
    svc.cancel();
    expect(fs.readdirSync(root)).toHaveLength(0);
  }));

  test('a cancel while Claude Code confirms the sign-in makes no account, and the login that was written is signed out', () => withPrimary(async (dir) => {
    const svc = new ClaudeLoginService(dir, tokenPty().spawn);
    let answer!: (v: { stdout: string; code: number }) => void;
    const execCalls: string[] = [];
    const children: FakeChild[] = [];
    const login = new ClaudeCliLogin({
      spawn: (() => { const c = new FakeChild((_l, ch) => ch.exit(0)); children.push(c); setTimeout(() => c.stdout.write(PRINTED), 2); return c as any; }) as any,
      exec: (async (_c: string, args: string[], o: { env: NodeJS.ProcessEnv }) => {
        execCalls.push(`${args.join(' ')} ${path.basename(String(o.env.CLAUDE_CONFIG_DIR))}`);
        if (args.join(' ') === 'auth status' && execCalls.filter((x) => x.startsWith('auth status')).length === 1) return new Promise((r) => { answer = r; });
        return { stdout: '{"loggedIn":false}', code: 0 };
      }) as any,
      env: () => ({ PATH: '/bin' }), startTimeoutMs: 1000, exchangeTimeoutMs: 1000,
    });
    svc.useFolderLogin(login);
    const got: unknown[] = [];
    svc.onAccountConfigDir = (i) => { got.push(i); };
    const root = path.join(dir, 'claude-accounts');
    await svc.startForAccount('Team', undefined, undefined, { folder: true });
    const id = fs.readdirSync(root)[0];
    const submit = svc.submitCode('c#s');
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    svc.cancel();
    answer({ stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', code: 0 });
    await submit;
    await vi.waitFor(() => expect(execCalls).toContain(`auth logout ${id}`));
    expect(got).toEqual([]);
    await vi.waitFor(() => expect(fs.readdirSync(root)).toHaveLength(0));
    expect(svc.status()).toBeNull();
  }));

  test('a code from a screen of another attempt is refused before it reaches any sign-in', () => withPrimary(async (dir) => {
    const pty = tokenPty();
    const svc = new ClaudeLoginService(dir, pty.spawn);
    const { login, children } = harness((_l, c) => c.exit(0));
    svc.useFolderLogin(login);
    const full = await svc.startForAccount('Team', 'acct1', undefined, { folder: true });
    const token = await svc.startForAccount('Work');
    // The first screen still shows the full sign-in and sends its code with its own attempt id.
    await expect(svc.submitCode('c#s', full.id)).rejects.toMatchObject({ code: 'no_session' });
    expect(pty.written).toEqual([]);
    const again = await svc.startForAccount('Team', 'acct1', undefined, { folder: true });
    await expect(svc.submitCode('token-code', token.id)).rejects.toMatchObject({ code: 'no_session' });
    expect(children[children.length - 1].lines).toEqual([]);
    // The right id, or no id (an older page), still goes through.
    expect((await svc.submitCode('c#s', again.id)).status).toBe('complete');
  }));

  test('removing the account fails in plain words when Claude Code still says the folder is signed in', () => withPrimary(async (dir) => {
    const svc = new ClaudeLoginService(dir, tokenPty().spawn);
    const stillIn = harness(() => {}); // `auth status` answers loggedIn: true after the logout
    svc.useFolderLogin(stillIn.login);
    await expect(svc.signOutAccountFolder(path.join(dir, 'claude-accounts', 'acct1'))).rejects.toThrow('Claude Code could not sign this account out');
    const out = harness(() => {}, '{"loggedIn":false}');
    svc.useFolderLogin(out.login);
    await expect(svc.signOutAccountFolder(path.join(dir, 'claude-accounts', 'acct1'))).resolves.toBeUndefined();
    // No answer (Claude Code is not installed any more): the removal goes on, nothing can be signed out.
    const silent = harness(() => {}, 'not json');
    svc.useFolderLogin(silent.login);
    await expect(svc.signOutAccountFolder(path.join(dir, 'claude-accounts', 'acct1'))).resolves.toBeUndefined();
  }));

  test('with no folder sign-in wired, a full sign-in is refused in plain words and nothing starts', () => withPrimary(async (dir) => {
    const svc = new ClaudeLoginService(dir, tokenPty().spawn);
    expect(svc.offersFolderLogin).toBe(false);
    await expect(svc.startForAccount('Team', undefined, undefined, { folder: true })).rejects.toThrow('This Dispatch cannot make a full sign-in');
    expect(svc.status()).toBeNull();
    expect(fs.existsSync(path.join(dir, 'claude-accounts'))).toBe(false);
  }));
});
