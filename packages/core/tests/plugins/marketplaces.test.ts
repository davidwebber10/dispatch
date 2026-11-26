import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MarketplaceService, ghCredentialArgs, gitErrorLine, gitNeedsLogin, isMarketplaceUrl } from '../../src/plugins/marketplaces.js';
import { makeMarket } from './market-fixture.js';

/** Marketplaces are git repositories (docs/superpowers/specs/2026-11-07-plugins-design.md, section 7.1). */
describe('MarketplaceService', () => {
  let tmp: string; let m: ReturnType<typeof makeMarket>; let svc: MarketplaceService;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-svc-'));
    m = makeMarket();
    svc = new MarketplaceService(path.join(tmp, 'marketplaces'), path.join(tmp, 'marketplaces.json'));
  });
  afterEach(() => { m.rm(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('add clones a repository by path and lists it with its name; a second add of the same url is the same row', async () => {
    const row = await svc.add(m.url);
    expect(row).toMatchObject({ url: m.url, name: 'Test market', description: 'For the tests', trusted: false, error: null });
    expect(row.slug).toMatch(/^[a-z0-9-]+$/);
    expect(fs.existsSync(path.join(tmp, 'marketplaces', row.slug, 'plugins', 'hello', 'plugin.json'))).toBe(true);
    expect((await svc.add(m.url)).slug).toBe(row.slug);
    expect(svc.list()).toHaveLength(1);
    expect(new MarketplaceService(path.join(tmp, 'marketplaces'), path.join(tmp, 'marketplaces.json')).list()[0].slug).toBe(row.slug);
  });

  it('a URL that looks like a flag, a relative path, or a string with control characters is refused', async () => {
    for (const bad of ['-oProxyCommand=evil', '--upload-pack=evil', 'relative/path', 'https://x.example/a b', 'https://x.example/a\nb', '']) {
      await expect(svc.add(bad), bad).rejects.toThrow(/not a marketplace url/i);
    }
    expect(svc.list()).toHaveLength(0);
  });

  it('the catalog lists plugins and skills at HEAD with the changelog', async () => {
    await svc.add(m.url);
    const cat = await svc.catalog();
    expect(cat.map((e) => [e.kind, e.id, e.version])).toEqual([['plugin', 'hello', '1.0.0'], ['skill', 'tidy', '0.1.0']]);
    expect(cat[0]).toMatchObject({ name: 'The hello plugin', description: 'hello does things', changelog: expect.stringContaining('The 1.0.0 notes') });
    expect(cat[1].marketplace).toBe(svc.list()[0].slug);
  });

  it('pull brings a new version; versions lists both with their commits, newest first', async () => {
    const row = await svc.add(m.url);
    m.plugin('hello', '1.1.0'); const second = m.commit('bump');
    expect((await svc.catalog())[0].version).toBe('1.0.0');
    const pulled = await svc.pull(row.slug);
    expect(pulled.error).toBeNull();
    expect(pulled.lastPulledAt).toBeTruthy();
    expect((await svc.catalog())[0].version).toBe('1.1.0');
    const v = await svc.versions(row.slug, 'hello');
    expect(v.map((x) => [x.version, x.commit])).toEqual([['1.1.0', second], ['1.0.0', m.first]]);
  });

  it('folderAt exports the plugin at a commit, without touching the clone', async () => {
    const row = await svc.add(m.url);
    m.plugin('hello', '1.1.0'); m.commit('bump');
    await svc.pull(row.slug);
    const old = await svc.folderAt(row.slug, 'hello', m.first);
    expect(JSON.parse(fs.readFileSync(path.join(old, 'plugin.json'), 'utf8')).version).toBe('1.0.0');
    expect(fs.readFileSync(path.join(old, 'web.js'), 'utf8')).toContain('V 1.0.0');
    const head = await svc.folderAt(row.slug, 'hello');
    expect(JSON.parse(fs.readFileSync(path.join(head, 'plugin.json'), 'utf8')).version).toBe('1.1.0');
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'marketplaces', row.slug, 'plugins', 'hello', 'plugin.json'), 'utf8')).version).toBe('1.1.0');
    expect(fs.existsSync(path.join(tmp, 'marketplaces', row.slug, 'skills', 'tidy', 'SKILL.md'))).toBe(true);
  });

  it('a clone that fails keeps git\'s last line on the row; pull retries it; remove drops the clone', async () => {
    const row = await svc.add(path.join(tmp, 'nowhere.git'));
    expect(row.error).toMatch(/does not exist|not found|No such/i);
    expect(svc.list()[0].error).toBe(row.error);
    expect(await svc.catalog()).toEqual([]);
    fs.cpSync(m.bare, path.join(tmp, 'nowhere.git'), { recursive: true });
    const again = await svc.pull(row.slug);
    expect(again.error).toBeNull();
    expect((await svc.catalog()).map((e) => e.id)).toEqual(['hello', 'tidy']);
    svc.remove(row.slug);
    expect(svc.list()).toEqual([]);
    expect(fs.existsSync(path.join(tmp, 'marketplaces', row.slug))).toBe(false);
  });

  it('setTrusted flips the flag and persists', async () => {
    const row = await svc.add(m.url);
    svc.setTrusted(row.slug, true);
    expect(svc.list()[0].trusted).toBe(true);
    expect(new MarketplaceService(path.join(tmp, 'marketplaces'), path.join(tmp, 'marketplaces.json')).list()[0].trusted).toBe(true);
  });

  it('gitErrorLine picks the line that explains an ssh or https failure, not the advice', () => {
    const ssh = 'Cloning into x...\ngit@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n';
    expect(gitErrorLine(ssh)).toBe('git@github.com: Permission denied (publickey).');
    const https = "Cloning into x...\nfatal: could not read Username for 'https://github.com': terminal prompts disabled\n";
    expect(gitErrorLine(https)).toBe("fatal: could not read Username for 'https://github.com': terminal prompts disabled");
    expect(gitErrorLine('fatal: repository \'x\' does not exist\n')).toBe("fatal: repository 'x' does not exist");
    expect(gitErrorLine('')).toBe('git failed');
  });

  // Seen on 2026-11-25: the person was signed in with the GitHub CLI, with ssh as its git protocol, so
  // git had no login for https. The clone of a private https marketplace failed with "could not read
  // Username", and the hint said to sign in with `gh auth login`, which the person already had done.
  it('the second try of an https marketplace asks the GitHub CLI, and only it, for that host; ssh and a path have no second try', () => {
    expect(ghCredentialArgs('https://github.com/org/plugins.git')).toEqual(['-c', 'credential.helper=', '-c', 'credential.https://github.com.helper=!gh auth git-credential']);
    expect(ghCredentialArgs('https://git.example.com:8443/org/plugins.git')[3]).toBe('credential.https://git.example.com:8443.helper=!gh auth git-credential');
    expect(ghCredentialArgs('git@github.com:org/plugins.git')).toEqual([]);
    expect(ghCredentialArgs('ssh://git@github.com/org/plugins.git')).toEqual([]);
    expect(ghCredentialArgs('/srv/git/plugins.git')).toEqual([]);
    expect(ghCredentialArgs('https://bad host/org/plugins.git')).toEqual([]);
    expect(ghCredentialArgs('https://github.com.helper=x -c core.sshCommand=y/org')).toEqual([]);
  });

  it('only a failure that says git found no login gets a second try', () => {
    expect(gitNeedsLogin("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toBe(true);
    expect(gitNeedsLogin("remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/x/y.git/'")).toBe(true);
    expect(gitNeedsLogin("fatal: repository 'https://github.com/x/y.git/' not found")).toBe(false);
    expect(gitNeedsLogin('fatal: unable to access: Could not resolve host: github.com')).toBe(false);
    expect(gitNeedsLogin('')).toBe(false);
  });

  it('with those arguments git gets the login from the GitHub CLI, and no other helper is asked to keep it', () => {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    // A stand-in for `gh`: it answers `gh auth git-credential get` as the real one does.
    fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\n[ "$1 $2 $3" = "auth git-credential get" ] && printf "username=x-access-token\\npassword=from-gh\\n"\n', { mode: 0o755 });
    // The person's own helper, as the macOS keychain helper of Apple's git is: it has no login, and
    // it keeps every login that git hands it. It writes down each call.
    const calls = path.join(tmp, 'own-helper-calls');
    fs.writeFileSync(path.join(bin, 'git-credential-own'), `#!/bin/sh\necho "$1" >> "${calls}"\ncat > /dev/null\n`, { mode: 0o755 });
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, '.gitconfig'), '[credential]\n\thelper = own\n');
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
    const git = (extra: string[], verb: string, input: string) => execFileSync('git', [...extra, 'credential', verb], { input, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const args = ghCredentialArgs('https://github.com/org/plugins.git');
    const got = git(args, 'fill', 'protocol=https\nhost=github.com\n\n');
    expect(got).toContain('password=from-gh');
    // What git does after a login worked: it hands the login to its helpers to keep.
    git(args, 'approve', got);
    expect(fs.existsSync(calls)).toBe(false); // the own helper was never called: nothing is stored
    // Without the arguments the same helper IS asked and IS handed the login: the measured side effect.
    git([], 'approve', got);
    expect(fs.readFileSync(calls, 'utf8')).toContain('store');
    // Another host is not asked through the GitHub CLI: git has no login and refuses, as before.
    expect(() => git(args, 'fill', 'protocol=https\nhost=gitlab.com\n\n')).toThrow(/could not read Username|terminal prompts disabled/);
  });

  it('a URL with a user or a token before the host is refused (no credential is ever stored)', () => {
    expect(isMarketplaceUrl('https://user:TOKEN@github.com/x/y.git')).toBe(false);
    expect(isMarketplaceUrl('https://github.com/x/y.git')).toBe(true);
    expect(isMarketplaceUrl('git@github.com:x/y.git')).toBe(true);
    expect(isMarketplaceUrl('ssh://git@github.com/x/y.git')).toBe(true);
    expect(isMarketplaceUrl('ssh://git@gitlab.example.com:2222/x/y.git')).toBe(true);
    expect(isMarketplaceUrl('ssh://user:pw@host/x/y.git')).toBe(false);
  });

  it('a marketplace removed while its pull runs does not throw', async () => {
    const row = await svc.add(m.url);
    const pull = svc.pull(row.slug);
    svc.remove(row.slug);
    await expect(pull).resolves.toBeTruthy();
    expect(svc.list()).toEqual([]);
  });

  // git writes into the clone while it pulls (FETCH_HEAD, lock files). A recursive delete of the
  // folder at that moment can fail with ENOTEMPTY: an entry appears between the listing and the
  // rmdir. So remove() leaves the folder of a pull in flight to that pull, which deletes it once
  // git has ended. The spy stands for git writing: while the pull runs, a delete of the clone fails.
  it('a marketplace removed while its pull runs leaves the folder to the pull, which then deletes it', async () => {
    const row = await svc.add(m.url);
    const clone = path.join(tmp, 'marketplaces', row.slug);
    let pulling = true;
    const real = fs.rmSync.bind(fs);
    const spy = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (pulling && String(target) === clone) throw Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${clone}/.git'`), { code: 'ENOTEMPTY' });
      return real(target, options);
    });
    try {
      const pull = svc.pull(row.slug);
      expect(() => svc.remove(row.slug)).not.toThrow();
      expect(svc.list()).toEqual([]);
      expect(fs.existsSync(clone)).toBe(true); // left to the pull
      pulling = false; // git has ended by the time the pull looks at the list again: its delete works
      await expect(pull).resolves.toMatchObject({ error: 'removed' });
      expect(fs.existsSync(clone)).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it('a marketplace removed with no pull in flight deletes its folder at once', async () => {
    const row = await svc.add(m.url);
    const clone = path.join(tmp, 'marketplaces', row.slug);
    expect(fs.existsSync(clone)).toBe(true);
    svc.remove(row.slug);
    expect(fs.existsSync(clone)).toBe(false);
  });
});
