import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MarketplaceService, gitErrorLine, isMarketplaceUrl } from '../../src/plugins/marketplaces.js';
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

  it('a URL with a user or a token before the host is refused (no credential is ever stored)', () => {
    expect(isMarketplaceUrl('https://user:TOKEN@github.com/x/y.git')).toBe(false);
    expect(isMarketplaceUrl('https://github.com/x/y.git')).toBe(true);
    expect(isMarketplaceUrl('git@github.com:x/y.git')).toBe(true);
  });

  it('a marketplace removed while its pull runs does not throw', async () => {
    const row = await svc.add(m.url);
    const pull = svc.pull(row.slug);
    svc.remove(row.slug);
    await expect(pull).resolves.toBeTruthy();
    expect(svc.list()).toEqual([]);
  });
});
