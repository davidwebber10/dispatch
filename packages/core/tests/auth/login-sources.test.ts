import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountsStore } from '../../src/auth/accounts.js';
import { claudeLoginSources } from '../../src/auth/claude-login-sources.js';

/**
 * One source for the Claude login (spec 2026-11-23). The first block is the table: what login each
 * kind of default gives a process. The second block is the guard: every file that starts `claude`
 * is on a list that says where its login comes from, so a new one cannot slip in with none.
 */
describe('the login of a Claude process', () => {
  let dir: string;
  const saved = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-sources-')); });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved;
  });

  const BASE = { PATH: '/bin', DISPATCH_API: 'http://127.0.0.1:1' };
  function install(kind: 'cli' | 'token' | 'hosted') {
    const store = new AccountsStore(dir);
    const team = store.addClaude({ token: 'tok-team', label: 'Team' });
    let hosted: string | null = null;
    if (kind === 'token') store.setDefault('claude', team.id);
    if (kind === 'hosted') {
      const h = store.upsertClaudeConfigDir({ id: 'box', label: 'Box', configDir: path.join(dir, 'cfg') });
      hosted = h.id;
      store.setDefault('claude', h.id);
    }
    return { store, team: team.id, hosted, src: claudeLoginSources(store, () => BASE) };
  }

  it('with the CLI login as the default, a process with no thread gets no token, also when the daemon itself has one', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok-from-the-daemon-environment';
    const { src } = install('cli');
    expect(src.overlay()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: '' });
    expect(src.processEnv().CLAUDE_CODE_OAUTH_TOKEN).toBe('');
    expect(src.processEnv('cli').CLAUDE_CODE_OAUTH_TOKEN).toBe('');
    expect(src.processEnv().DISPATCH_API).toBe('http://127.0.0.1:1');
  });

  it('with a token account as the default, a process with no thread gets that token; `cli` still means the login of the machine', () => {
    const { src, team } = install('token');
    expect(src.overlay()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-team' });
    expect(src.processEnv().CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-team');
    expect(src.processEnv(team).CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-team');
    expect(src.processEnv('cli').CLAUDE_CODE_OAUTH_TOKEN).toBe('');
  });

  it('a hosted account gives its config folder and never a token', () => {
    const { src, hosted } = install('hosted');
    if (!hosted) throw new Error('no hosted account');
    expect(src.overlay()).toEqual({ CLAUDE_CONFIG_DIR: path.join(dir, 'cfg'), CLAUDE_CODE_OAUTH_TOKEN: '' });
  });

  it('a thread runs on its own account; a thread with none, or with an account that is gone, runs on the default', () => {
    const { src, team } = install('cli');
    expect(src.accountOf({ accountId: team })).toBe(team);
    expect(src.accountOf({})).toBe('cli');
    expect(src.accountOf(null)).toBe('cli');
    expect(src.accountOf({ accountId: 'removed-long-ago' })).toBe('cli');
    expect(src.overlay(src.accountOf({ accountId: team }))).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-team' });
  });
});

describe('every place that starts claude takes its login from the account', () => {
  const SRC = path.join(__dirname, '..', '..', 'src');
  /** The files that may start the `claude` command, each with where its login comes from. */
  const KNOWN: Record<string, string> = {
    'providers/claude-code.ts': 'the command line of a thread; the thread spawner adds the overlay of the thread (sessions/thread-spawner.ts)',
    'providers/claude-prompt-file.ts': '`claude --version` only: no login is used',
    'endless/turn-runner.ts': 'a Chat turn: the `loginEnv` of the default account',
    'endless/summarizer-claude.ts': 'a Chat compaction: the `loginEnv` of the default account',
    'sessions/cli-namer.ts': 'a thread title: `env(accountId)` of the thread that is named',
    'assist/run.ts': 'a plugin assist call: `accountEnv` of the request, else of the default',
    'limits/claude-probe.ts': 'the usage probe turn: `env(accountId)` of the account that is probed',
    'limits/claude-get-usage.ts': 'the usage read: `env(accountId)`, and it blanks the token itself',
    'auth/claude-login.ts': '`claude setup-token`: it signs in, so it starts with no token',
    'auth/claude-cli-login.ts': '`claude auth ...` on a hosted box: the token is always cleared',
    'setup/install.ts': 'the install command line (`claude auth login`): a person signs in',
    'setup/detect.ts': '`claude auth status` under the probe env, which holds no token',
  };

  function files(dirPath: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, e.name);
      if (e.isDirectory()) files(full, out);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts')) out.push(full);
    }
    return out;
  }
  // A file starts `claude` when it names the command for a spawn, or resolves its binary.
  const STARTS = /command:\s*(?:[\w.?]+\s*\?\?\s*)?'claude'|(?:spawn\w*|execFile\w*)\(\s*'claude'|(?:resolveBin|usable)\(\s*'claude'|[bB]in\s*\?\?\s*'claude'|AUTH_PROBES\[name\]/;

  it('the list of files that start claude is exactly the known one', () => {
    const found = files(SRC).filter((f) => STARTS.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(SRC, f).split(path.sep).join('/')).sort();
    expect(found).toEqual(Object.keys(KNOWN).sort());
  });

  it('the base environment of every child holds no Claude token', () => {
    const wire = fs.readFileSync(path.join(SRC, 'daemon', 'wire-pty.ts'), 'utf8');
    expect(wire).not.toMatch(/claudeLogin\.getSpawnEnv\(\)/);
  });
});
