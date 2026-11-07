import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { publishPlugin, type Runner } from '../src/plugin-publish.js';

/** `dispatch plugin publish` against a bare repository on disk, with gh faked through the runner seam (plugins slice 7). */
describe('publishPlugin', () => {
  let root: string; let bare: string; let work: string; let folder: string; let log: string[]; let ghCalls: string[][];
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  const runner = (gh: 'present' | 'absent' = 'present'): Runner => (cmd, args, opts) => {
    if (cmd === 'gh') { ghCalls.push(args); return gh === 'present' ? { code: 0, stdout: 'https://github.com/polywood/dispatch-plugins/pull/7\n', stderr: '' } : { code: 127, stdout: '', stderr: 'gh: command not found' }; }
    const r = spawnSync(cmd, args, { cwd: opts.cwd, env, encoding: 'utf8' });
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const plugin = (version: string, extra: Record<string, unknown> = {}) => {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'plugin.json'), JSON.stringify({ id: 'hello', name: 'Hello', version, web: 'web.js', ...extra }));
    fs.writeFileSync(path.join(folder, 'web.js'), `export default (d) => d.register(d.id, {}); // ${version}`);
  };
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'publish-')));
    bare = path.join(root, 'market.git'); work = path.join(root, 'work'); folder = path.join(root, 'hello');
    fs.mkdirSync(bare); g(bare, 'init', '-q', '--bare', '-b', 'main');
    g(root, 'clone', '-q', bare, work);
    fs.writeFileSync(path.join(work, 'marketplace.json'), '{"name":"m"}'); g(work, 'add', '-A'); g(work, 'commit', '-q', '-m', 'init'); g(work, 'push', '-q', 'origin', 'main');
    log = []; ghCalls = [];
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
  const opts = (over: Record<string, unknown> = {}) => ({ folder, marketplace: bare, run: runner(), log: (l: string) => log.push(l), tmpDir: path.join(root, 'tmp'), ...over });

  it('publishes a valid folder on a branch with one commit under plugins/<id>, pushes it, and opens a pull request through gh', async () => {
    plugin('1.0.0');
    const r = await publishPlugin(opts());
    expect(r).toEqual({ id: 'hello', version: '1.0.0', branch: 'plugin/hello-1.0.0', prUrl: 'https://github.com/polywood/dispatch-plugins/pull/7', compareUrl: null });
    expect(g(bare, 'branch', '--list').trim().split('\n').map((s) => s.replace('*', '').trim()).sort()).toEqual(['main', 'plugin/hello-1.0.0']);
    expect(g(bare, 'ls-tree', '-r', '--name-only', 'plugin/hello-1.0.0').trim().split('\n').sort()).toEqual(['marketplace.json', 'plugins/hello/plugin.json', 'plugins/hello/web.js']);
    expect(g(bare, 'log', '-1', '--format=%s', 'plugin/hello-1.0.0').trim()).toBe('plugins: hello 1.0.0');
    expect(ghCalls[0].slice(0, 3)).toEqual(['pr', 'create', '--title']);
    expect(ghCalls[0]).toContain('--head');
    expect(fs.readdirSync(path.join(root, 'tmp'))).toEqual([]);
  });

  it('gh absent: the branch is pushed and the compare URL is printed for a GitHub marketplace', async () => {
    plugin('1.0.0');
    const r = await publishPlugin(opts({ run: runner('absent'), marketplace: bare, githubUrlFor: () => 'https://github.com/polywood/dispatch-plugins.git' }));
    expect(r.prUrl).toBeNull();
    expect(r.compareUrl).toBe('https://github.com/polywood/dispatch-plugins/compare/plugin/hello-1.0.0?expand=1');
  });

  it('the copy skips node_modules, the install record and symlinks', async () => {
    plugin('1.0.0');
    fs.mkdirSync(path.join(folder, 'node_modules', 'x'), { recursive: true }); fs.writeFileSync(path.join(folder, 'node_modules', 'x', 'i.js'), '');
    fs.writeFileSync(path.join(folder, '.dispatch-install.json'), '{}');
    fs.symlinkSync(path.join(root, 'work', 'marketplace.json'), path.join(folder, 'escape.json'));
    await publishPlugin(opts());
    expect(g(bare, 'ls-tree', '-r', '--name-only', 'plugin/hello-1.0.0').trim().split('\n').sort()).toEqual(['marketplace.json', 'plugins/hello/plugin.json', 'plugins/hello/web.js']);
  });

  it('a version not newer than the marketplace\'s is refused with both versions named; 1.10.0 beats 1.9.0', async () => {
    fs.mkdirSync(path.join(work, 'plugins', 'hello'), { recursive: true });
    fs.writeFileSync(path.join(work, 'plugins', 'hello', 'plugin.json'), JSON.stringify({ id: 'hello', name: 'Hello', version: '1.9.0' }));
    g(work, 'add', '-A'); g(work, 'commit', '-q', '-m', 'hello 1.9'); g(work, 'push', '-q', 'origin', 'main');
    plugin('1.9.0');
    await expect(publishPlugin(opts())).rejects.toThrow(/1\.9\.0 is not newer than 1\.9\.0/);
    plugin('1.10.0');
    expect((await publishPlugin(opts())).branch).toBe('plugin/hello-1.10.0');
  });

  it('a folder without a plugin.json, or with a bad one, and a bad marketplace are refused', async () => {
    await expect(publishPlugin(opts())).rejects.toThrow(/no plugin.json/);
    fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, 'plugin.json'), '{ "id": "other", "name": "x", "version": "1" }');
    await expect(publishPlugin(opts())).rejects.toThrow(/id/);
    plugin('1.0.0');
    await expect(publishPlugin(opts({ marketplace: '--upload-pack=x' }))).rejects.toThrow(/not a marketplace/);
    await expect(publishPlugin(opts({ marketplace: 'no-such-slug', dataDir: root }))).rejects.toThrow(/no marketplace named/);
  });

  it('--to accepts a slug the daemon knows; a failed push leaves no temp clone and names git\'s line', async () => {
    plugin('1.0.0');
    fs.writeFileSync(path.join(root, 'marketplaces.json'), JSON.stringify({ marketplaces: [{ url: bare, slug: 'market-abc123', trusted: false }] }));
    expect((await publishPlugin(opts({ marketplace: 'market-abc123', dataDir: root, dryRun: true }))).branch).toBe('plugin/hello-1.0.0');
    expect(g(bare, 'branch', '--list').replace('*', '').trim()).toBe('main'); // dry run: nothing pushed
    // A push creates refs/heads/plugin/…: a read-only refs/heads refuses it.
    fs.chmodSync(path.join(bare, 'refs', 'heads'), 0o500);
    try { await expect(publishPlugin(opts())).rejects.toThrow(/push failed:/); } finally { fs.chmodSync(path.join(bare, 'refs', 'heads'), 0o755); }
    expect(fs.readdirSync(path.join(root, 'tmp'))).toEqual([]);
  });
});
