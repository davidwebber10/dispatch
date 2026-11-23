import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountsStore } from '../../src/auth/accounts.js';
import { claudeLoginSources, makeClaudeSignedIn, boxClaudeAuthenticated } from '../../src/auth/claude-login-sources.js';

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

// Review of #189: the real checker, not a stand-in. A check that could not answer is 'unknown',
// never false: a gate treats only a definite "signed out" as closed.
describe('is the account signed in that a process will run on', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-signed-in-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function setup(over: { clean?: boolean; cliStatus?: (o?: { configDir?: string | null }) => Promise<{ loggedIn: boolean } | null>; machine?: () => Promise<boolean | 'unknown'> } = {}) {
    const store = new AccountsStore(dir);
    const team = store.addClaude({ token: 'tok-team', label: 'Team' });
    const box = store.upsertClaudeConfigDir({ id: 'box', label: 'Box', configDir: path.join(dir, 'cfg') });
    const asked: string[] = [];
    const signedIn = makeClaudeSignedIn({
      accounts: store, usesCleanLogin: () => over.clean === true,
      cliStatus: async (o) => { asked.push(`status:${o?.configDir ?? 'primary'}`); return over.cliStatus ? over.cliStatus(o) : { loggedIn: true }; },
      machine: async () => { asked.push('machine'); return over.machine ? over.machine() : true; },
    });
    return { store, team: team.id, box: box.id, signedIn, asked };
  }

  it('a saved sign-in is signed in when it is stored, whatever the machine login says', async () => {
    const t = setup({ machine: async () => false });
    expect(await t.signedIn(t.team)).toBe(true);
    expect(t.asked).toEqual([]);
    t.store.setDefault('claude', t.team);
    expect(await t.signedIn()).toBe(true); // no id: the default account
    expect(await t.signedIn('cli')).toBe(false);
  });

  it('the CLI login is the machine check; an unknown id is the default account', async () => {
    const t = setup({ machine: async () => 'unknown' });
    expect(await t.signedIn()).toBe('unknown');
    expect(await t.signedIn('gone')).toBe('unknown');
    expect(t.asked).toEqual(['machine', 'machine']);
  });

  it('a hosted account, and the primary login of a clean-login box, ask Claude Code; no answer is unknown, not signed out', async () => {
    const yes = setup({ clean: true });
    expect(await yes.signedIn(yes.box)).toBe(true);
    expect(await yes.signedIn('cli')).toBe(true);
    expect(yes.asked).toEqual([`status:${path.join(dir, 'cfg')}`, 'status:primary']);
    const none = setup({ clean: true, cliStatus: async () => null });
    expect(await none.signedIn(none.box)).toBe('unknown');
    expect(await none.signedIn('cli')).toBe('unknown');
    const thrown = setup({ clean: true, cliStatus: async () => { throw new Error('timeout'); } });
    expect(await thrown.signedIn('cli')).toBe('unknown');
    const out = setup({ clean: true, cliStatus: async () => ({ loggedIn: false }) });
    expect(await out.signedIn('cli')).toBe(false);
  });

  it('a box in token mode is authenticated when its default account has a stored sign-in; the old file alone does not count', () => {
    const t = setup();
    expect(boxClaudeAuthenticated({ accounts: t.store, usesCleanLogin: false, cleanAuthenticated: () => false })).toBe(false); // the default is the CLI login
    t.store.setDefault('claude', t.team);
    expect(boxClaudeAuthenticated({ accounts: t.store, usesCleanLogin: false, cleanAuthenticated: () => false })).toBe(true);
    // The clean login keeps its own answer.
    expect(boxClaudeAuthenticated({ accounts: t.store, usesCleanLogin: true, cleanAuthenticated: () => false })).toBe(false);
    expect(boxClaudeAuthenticated({ accounts: t.store, usesCleanLogin: true, cleanAuthenticated: () => true })).toBe(true);
  });
});

describe('every place that starts claude takes its login from the account', () => {
  const SRC = path.join(__dirname, '..', '..', 'src');
  /**
   * The files that may start the `claude` command: how many places in each, and where the login
   * of each comes from. A new place in a known file changes its count, so it fails here too.
   */
  const KNOWN: Record<string, { sites: number; login: string }> = {
    'providers/claude-code.ts': { sites: 5, login: 'the command line of a thread; the thread spawner adds the overlay of the thread (sessions/thread-spawner.ts)' },
    'providers/claude-prompt-file.ts': { sites: 1, login: '`claude --version` only: no login is used' },
    'endless/turn-runner.ts': { sites: 1, login: 'a Chat turn: the `loginEnv` of the default account' },
    'endless/summarizer-claude.ts': { sites: 1, login: 'a Chat compaction: the `loginEnv` of the default account' },
    'sessions/cli-namer.ts': { sites: 1, login: 'a thread title: `env(accountId)` of the thread that is named' },
    'assist/run.ts': { sites: 2, login: 'a plugin assist call: `accountEnv` of the request, else of the default (the second place only asks "usable?")' },
    'limits/claude-probe.ts': { sites: 1, login: 'the usage probe turn: `env(accountId)` of the account that is probed' },
    'limits/claude-get-usage.ts': { sites: 1, login: 'the usage read: `env(accountId)`, and it blanks the token itself' },
    'auth/claude-login.ts': { sites: 1, login: '`claude setup-token`: it signs in, so it starts with no token' },
    'auth/claude-cli-login.ts': { sites: 1, login: '`claude auth ...` on a hosted box: the token is always cleared' },
    'setup/install.ts': { sites: 1, login: 'the install command line (`claude auth login`): a person signs in' },
    'setup/detect.ts': { sites: 1, login: '`claude auth status` for the login of the machine: the token is blanked' },
  };

  function files(dirPath: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, e.name);
      if (e.isDirectory()) files(full, out);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts')) out.push(full);
    }
    return out;
  }
  // A place starts `claude` when it names the command for a spawn (either quote), or resolves its
  // binary. This is a scan of text: it cannot see a command that is built in a variable first. The
  // base environment with no token (below) is what keeps such a place from a wrong login.
  const STARTS = /command:\s*(?:[\w.?]+\s*\?\?\s*)?['"]claude['"]|(?:spawn\w*|execFile\w*)\(\s*['"]claude['"]|(?:resolveBin|usable)\(\s*['"]claude['"]|[bB]in\s*\?\?\s*['"]claude['"]|AUTH_PROBES\[name\]/g;

  it('the places that start claude are exactly the known ones, file by file', () => {
    const found: Record<string, number> = {};
    for (const f of files(SRC)) {
      const n = (fs.readFileSync(f, 'utf8').match(STARTS) ?? []).length;
      if (n) found[path.relative(SRC, f).split(path.sep).join('/')] = n;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(KNOWN).map(([file, k]) => [file, k.sites])));
  });

  it('the scan sees both quote styles and a spawn call', () => {
    for (const line of ["spawn('claude', args)", 'spawn("claude", args)', "execFileSync(\"claude\", ['-p'])", "command: d.command ?? 'claude',", 'const bin = opts.claudeBin ?? "claude";', "await usable('claude', deps)"]) {
      expect(line.match(STARTS), line).not.toBeNull();
    }
    expect("const harness = opts.harness ?? 'claude';".match(STARTS)).toBeNull(); // a harness name is not a command
  });

  it('the base environment of every child holds no Claude login', () => {
    const wire = fs.readFileSync(path.join(SRC, 'daemon', 'wire-pty.ts'), 'utf8');
    expect(wire).not.toMatch(/claudeLogin\.getSpawnEnv\(\)/);
    expect(wire).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR/);
  });
});
