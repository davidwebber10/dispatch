import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { KeyRegistry } from '../../src/auth/principals.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('PluginRegistry', () => {
  let tmp: string;
  let dir: string;
  let events: Record<string, unknown>[];
  let keys: KeyRegistry;
  const keyDir = () => path.join(tmp, 'keys');
  const reg = (running = '3.28.0') => new PluginRegistry(dir, { broadcast: (e) => { events.push(e); } }, running, { keys, keyDir: keyDir() });
  const plugin = (id: string, manifest: Record<string, unknown> | string, web = 'export default () => {}') => {
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    fs.writeFileSync(path.join(dir, id, 'plugin.json'), typeof manifest === 'string' ? manifest : JSON.stringify({ id, name: id, version: '1.0.0', web: 'web.js', ...manifest }));
    fs.writeFileSync(path.join(dir, id, 'web.js'), web);
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-'));
    dir = path.join(tmp, 'plugins');
    events = [];
    keys = new KeyRegistry();
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('lists nothing when the folder does not exist', () => {
    expect(reg().list()).toEqual([]);
  });

  it('lists manifests sorted by id, with a stamp, enabled by default', () => {
    plugin('b-one', {}); plugin('a-two', { description: 'two' });
    const rows = reg().list();
    expect(rows.map((r) => r.id)).toEqual(['a-two', 'b-one']);
    expect(rows[0]).toMatchObject({ name: 'a-two', version: '1.0.0', web: 'web.js', description: 'two', enabled: true, install: null });
    expect(rows[0].stamp).toBeGreaterThan(0);
    expect(rows[0].error).toBeUndefined();
  });

  it('a folder with invalid JSON lists as broken', () => {
    plugin('broken', '{ nope');
    const [row] = reg().list();
    expect(row).toMatchObject({ id: 'broken', name: 'broken', version: '0.0.0', enabled: false });
    expect(row.error).toMatch(/JSON/);
  });

  it('a folder with an id mismatch lists as broken with the reason', () => {
    plugin('x', { id: 'y' });
    expect(reg().list()[0].error).toBe('plugin.json id "y" does not match the folder "x"');
  });

  it('a manifest needing a newer Dispatch lists as broken', () => {
    plugin('future', { dispatch: '>=99.0' });
    expect(reg('3.28.0').list()[0].error).toBe('needs Dispatch >=99.0; this is 3.28.0');
    expect(reg('99.0.0').list()[0].error).toBeUndefined();
  });

  it('ignores folders whose name is not a valid id, and files', () => {
    plugin('Bad Name', {}); plugin('ok', {});
    fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
    expect(reg().list().map((r) => r.id)).toEqual(['ok']);
  });

  it('reads an install record when present', () => {
    plugin('shop', {});
    fs.writeFileSync(path.join(dir, 'shop', '.dispatch-install.json'), JSON.stringify({ marketplace: 'dispatchd', version: '1.0.0', sha256: 'abc', installedAt: '2026-11-07T00:00:00Z' }));
    expect(reg().get('shop')?.install).toEqual({ marketplace: 'dispatchd', version: '1.0.0', sha256: 'abc', installedAt: '2026-11-07T00:00:00Z', commit: '' });
  });

  it('setEnabled persists across a new registry over the same dir', () => {
    plugin('p', {});
    const r = reg();
    expect(r.setEnabled('p', false).enabled).toBe(false);
    expect(reg().get('p')?.enabled).toBe(false);
    expect(reg().setEnabled('p', true).enabled).toBe(true);
    expect(() => r.setEnabled('nope', true)).toThrow('unknown plugin');
  });

  it('resolveFile confines to the real folder and refuses disabled plugins', () => {
    plugin('p', {});
    fs.writeFileSync(path.join(tmp, 'secret'), 's');
    const r = reg();
    expect(r.resolveFile('p', 'web.js')).toBe(fs.realpathSync(path.join(dir, 'p', 'web.js')));
    expect(r.resolveFile('p', '../../secret')).toBeNull();
    expect(r.resolveFile('p', '/etc/passwd')).toBeNull();
    expect(r.resolveFile('p', '')).toBeNull();
    expect(r.resolveFile('p', '.')).toBeNull();
    expect(r.resolveFile('nope', 'web.js')).toBeNull();
    r.setEnabled('p', false);
    expect(r.resolveFile('p', 'web.js')).toBeNull();
  });

  it('a symlinked plugin folder resolves inside its target, and a link that escapes is refused', () => {
    const real = path.join(tmp, 'elsewhere', 'linked');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'plugin.json'), JSON.stringify({ id: 'linked', name: 'L', version: '1', web: 'web.js' }));
    fs.writeFileSync(path.join(real, 'web.js'), '');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(real, path.join(dir, 'linked'));
    fs.writeFileSync(path.join(tmp, 'elsewhere', 'secret'), 's');
    fs.symlinkSync(path.join(tmp, 'elsewhere', 'secret'), path.join(real, 'leak'));
    const r = reg();
    expect(r.get('linked')?.name).toBe('L');
    expect(r.resolveFile('linked', 'web.js')).toBe(fs.realpathSync(path.join(real, 'web.js')));
    expect(r.resolveFile('linked', 'leak')).toBeNull();
  });

  it('scaffold writes plugin.json, web.js and README.md and refuses an existing id or a bad id', () => {
    const r = reg();
    const row = r.scaffold('my-plugin', 'My plugin');
    expect(row).toMatchObject({ id: 'my-plugin', name: 'My plugin', version: '0.1.0', web: 'web.js', enabled: true });
    for (const f of ['plugin.json', 'web.js', 'README.md']) expect(fs.existsSync(path.join(dir, 'my-plugin', f))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'my-plugin', 'web.js'), 'utf8')).toContain("register('my-plugin'");
    expect(() => r.scaffold('my-plugin', 'Again')).toThrow('exists');
    expect(() => r.scaffold('Bad Id', 'x')).toThrow('bad id');
  });

  it('remove deletes a local plugin and an installed one (its .prev too); a bundled one and an unknown id are refused', () => {
    plugin('local', {}); plugin('shop', {});
    fs.writeFileSync(path.join(dir, 'shop', '.dispatch-install.json'), '{"marketplace":"m","version":"1","sha256":"x","installedAt":"t"}');
    const r = reg();
    r.remove('local');
    expect(fs.existsSync(path.join(dir, 'local'))).toBe(false);
    fs.mkdirSync(path.join(dir, 'shop.prev'));
    r.remove('shop');
    expect(fs.existsSync(path.join(dir, 'shop'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'shop.prev'))).toBe(false);
    expect(() => r.remove('nope')).toThrow('unknown plugin');
  });

  it('the stamp follows every file in the folder, not only plugin.json and the bundle', async () => {
    plugin('p', {});
    fs.mkdirSync(path.join(dir, 'p', 'lib'));
    fs.writeFileSync(path.join(dir, 'p', 'lib', 'util.js'), 'export const a = 1;');
    const before = reg().get('p')!.stamp;
    await sleep(20);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dir, 'p', 'lib', 'util.js'), later, later);
    expect(reg().get('p')!.stamp).toBeGreaterThan(before);
  });

  it('start() watches a symlinked plugin folder too: an edit to its target announces the plugin', async () => {
    const real = path.join(tmp, 'elsewhere', 'linked');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'plugin.json'), JSON.stringify({ id: 'linked', name: 'L', version: '1', web: 'web.js' }));
    fs.writeFileSync(path.join(real, 'web.js'), 'export default () => 1');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(real, path.join(dir, 'linked'));
    const r = reg();
    r.start();
    try {
      await sleep(50);
      fs.writeFileSync(path.join(real, 'web.js'), 'export default () => 2');
      await sleep(400);
      const changes = events.filter((e) => e.type === 'plugin:changed');
      expect(changes.length).toBeGreaterThanOrEqual(1);
      expect(changes[0]).toMatchObject({ id: 'linked', plugin: expect.objectContaining({ id: 'linked' }) });
    } finally { r.stop(); }
  });

  it('announce broadcasts plugin:changed with the row', () => {
    plugin('p', {});
    reg().announce('p');
    expect(events).toEqual([{ type: 'plugin:changed', id: 'p', plugin: expect.objectContaining({ id: 'p', enabled: true }) }]);
  });

  it('start() broadcasts plugin:changed once per burst of writes, and null for a removed folder', async () => {
    plugin('p', {});
    const r = reg();
    r.start();
    try {
      await sleep(50);
      fs.writeFileSync(path.join(dir, 'p', 'web.js'), 'export default () => 1');
      fs.writeFileSync(path.join(dir, 'p', 'web.js'), 'export default () => 2');
      await sleep(400);
      // FSEvents can split one burst into two notifications more than 150 ms apart under load,
      // so the count is "at least one, and never one per write"; every announcement carries the row.
      const changes = events.filter((e) => e.type === 'plugin:changed');
      expect(changes.length).toBeGreaterThanOrEqual(1);
      expect(changes.length).toBeLessThanOrEqual(2);
      for (const c of changes) expect(c).toMatchObject({ id: 'p', plugin: expect.objectContaining({ id: 'p' }) });
      events.length = 0;
      fs.rmSync(path.join(dir, 'p'), { recursive: true });
      await sleep(400);
      expect(events.filter((e) => e.type === 'plugin:changed')).toEqual([{ type: 'plugin:changed', id: 'p', plugin: null }]);
    } finally { r.stop(); }
  });
});

describe('PluginRegistry keys (2026-11-07)', () => {
  let tmp: string; let dir: string; let keys: KeyRegistry; let events: Record<string, unknown>[];
  const reg = () => new PluginRegistry(dir, { broadcast: (e) => { events.push(e); } }, '3.28.0', { keys, keyDir: path.join(tmp, 'keys') });
  const plugin = (id: string, extra: Record<string, unknown> = {}) => {
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    fs.writeFileSync(path.join(dir, id, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', web: 'web.js', permissions: ['read:threads'], ...extra }));
    fs.writeFileSync(path.join(dir, id, 'web.js'), '');
  };
  const keyFile = (id: string) => path.join(tmp, 'keys', `plugin-${id}`);
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-keys-')); dir = path.join(tmp, 'plugins'); keys = new KeyRegistry(); events = []; });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('issueKeys writes a 0600 key file per enabled plugin and none for a disabled or broken one', () => {
    plugin('on'); plugin('off'); plugin('broken', { id: 'other' });
    const r = reg();
    r.setEnabled('off', false);
    r.issueKeys();
    const literal = fs.readFileSync(keyFile('on'), 'utf8');
    expect(literal).toMatch(/^dpk_[A-Za-z0-9_-]{43}\n$/);
    expect(fs.statSync(keyFile('on')).mode & 0o777).toBe(0o600);
    expect(keys.resolve(literal.trim())).toMatchObject({ kind: 'plugin', pluginId: 'on' });
    expect(fs.existsSync(keyFile('off'))).toBe(false);
    expect(fs.existsSync(keyFile('broken'))).toBe(false);
    expect(r.get('on')!.keyed).toBe(true);
    expect(r.get('off')!.keyed).toBe(false);
  });

  it('disable revokes the key at once and deletes the file; enable mints a new one', () => {
    plugin('p');
    const r = reg(); r.issueKeys();
    const first = fs.readFileSync(keyFile('p'), 'utf8').trim();
    r.setEnabled('p', false);
    expect(keys.resolve(first)).toBeNull();
    expect(fs.existsSync(keyFile('p'))).toBe(false);
    r.setEnabled('p', true);
    const second = fs.readFileSync(keyFile('p'), 'utf8').trim();
    expect(second).not.toBe(first);
    expect(keys.resolve(second)).toMatchObject({ kind: 'plugin', pluginId: 'p' });
  });

  it('remove revokes the key and deletes the file', () => {
    plugin('p');
    const r = reg(); r.issueKeys();
    const k = fs.readFileSync(keyFile('p'), 'utf8').trim();
    r.remove('p');
    expect(keys.resolve(k)).toBeNull();
    expect(fs.existsSync(keyFile('p'))).toBe(false);
  });

  it('a plugin that appears, is scaffolded, or is fixed after boot gets a key on announce; a removed folder loses its key file', () => {
    const r = reg(); r.issueKeys();
    plugin('late');
    expect(r.get('late')!.keyed).toBe(false);
    r.announce('late');
    expect(r.get('late')!.keyed).toBe(true);
    expect(fs.existsSync(keyFile('late'))).toBe(true);
    const made = r.scaffold('fresh', 'Fresh');
    expect(made.keyed).toBe(true);
    plugin('fixme', { id: 'wrong' });
    r.announce('fixme');
    expect(fs.existsSync(keyFile('fixme'))).toBe(false);
    plugin('fixme');
    r.announce('fixme');
    expect(r.get('fixme')!.keyed).toBe(true);
    fs.rmSync(path.join(dir, 'late'), { recursive: true });
    r.announce('late');
    expect(fs.existsSync(keyFile('late'))).toBe(false);
    // a stale key file from a folder deleted while the daemon was down is swept at boot
    fs.writeFileSync(keyFile('ghost'), 'dpk_x\n');
    reg().issueKeys();
    expect(fs.existsSync(keyFile('ghost'))).toBe(false);
  });

  it('facts(id) returns the manifest permissions; null for unknown, disabled or broken', () => {
    plugin('p'); plugin('broken', { id: 'x' });
    const r = reg();
    expect(r.facts('p')).toEqual({ id: 'p', permissions: ['read:threads'] });
    expect(r.facts('nope')).toBeNull();
    expect(r.facts('broken')).toBeNull();
    r.setEnabled('p', false);
    expect(r.facts('p')).toBeNull();
  });
});

describe('bundled plugins (2026-11-07, spec section 10)', () => {
  let tmp: string; let dir: string; let bundled: string; let keys: KeyRegistry;
  const reg = (b: string | undefined = bundled) => new PluginRegistry(dir, { broadcast: () => {} }, '3.28.0', { keys, keyDir: path.join(tmp, 'keys'), bundledDir: b });
  const write = (root: string, id: string, extra: Record<string, unknown> = {}) => {
    fs.mkdirSync(path.join(root, id), { recursive: true });
    fs.writeFileSync(path.join(root, id, 'plugin.json'), JSON.stringify({ id, name: `B ${id}`, version: '2.0.0', web: 'web.js', ...extra }));
    fs.writeFileSync(path.join(root, id, 'web.js'), 'export default () => {}');
  };
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-bundled-')); dir = path.join(tmp, 'plugins'); bundled = path.join(tmp, 'bundled'); keys = new KeyRegistry(); fs.mkdirSync(dir, { recursive: true }); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('a bundled plugin starts disabled unless its manifest says enabledByDefault; the owner turns it on, and that survives a restart', () => {
    write(bundled, 'prompt-coach');
    write(bundled, 'previews', { enabledByDefault: true });
    let r = reg(); r.issueKeys();
    expect(r.get('prompt-coach')).toMatchObject({ enabled: false, keyed: false, bundled: true });
    expect(r.get('previews')).toMatchObject({ enabled: true, keyed: true, bundled: true });
    r.setEnabled('prompt-coach', true);
    expect(r.get('prompt-coach')).toMatchObject({ enabled: true, keyed: true });
    r = reg(); r.issueKeys();
    expect(r.get('prompt-coach')!.enabled).toBe(true);
    r.setEnabled('prompt-coach', false);
    expect(reg().get('prompt-coach')!.enabled).toBe(false);
    r.setEnabled('previews', false);
    expect(reg().get('previews')!.enabled).toBe(false);
    // A local plugin is enabled by default, as before.
    write(dir, 'local-one');
    expect(reg().get('local-one')!.enabled).toBe(true);
  });

  it('a bundled plugin lists with bundled: true, serves its files, gets a key, cannot be removed, and copies to local under a new id', () => {
    write(bundled, 'prompt-coach', { enabledByDefault: true });
    const r = reg(); r.issueKeys();
    const row = r.get('prompt-coach')!;
    expect(row).toMatchObject({ id: 'prompt-coach', name: 'B prompt-coach', bundled: true, enabled: true, keyed: true, install: null });
    expect(r.list().map((p) => p.id)).toEqual(['prompt-coach']);
    expect(r.resolveFile('prompt-coach', 'web.js')).toBe(fs.realpathSync(path.join(bundled, 'prompt-coach', 'web.js')));
    expect(() => r.remove('prompt-coach')).toThrow('bundled');
    const copy = r.copyToLocal('prompt-coach', 'my-coach');
    expect(copy).toMatchObject({ id: 'my-coach', name: 'B prompt-coach', install: null });
    expect(copy.bundled).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'my-coach', 'plugin.json'), 'utf8')).id).toBe('my-coach');
    expect(fs.existsSync(path.join(dir, 'my-coach', 'web.js'))).toBe(true);
    expect(() => r.copyToLocal('prompt-coach', 'my-coach')).toThrow('exists');
    expect(() => r.copyToLocal('nope', 'x')).toThrow('unknown plugin');
  });

  it('a local plugin with the same id shadows the bundled one, and the row says so', () => {
    write(bundled, 'twin'); write(dir, 'twin', { name: 'Local twin' });
    const rows = reg().list();
    expect(rows.map((p) => [p.id, p.name, p.bundled ?? false, p.shadowsBundled ?? false])).toEqual([['twin', 'Local twin', false, true]]);
  });

  it('disable works on a bundled plugin and persists; a missing bundled dir lists nothing', () => {
    write(bundled, 'b');
    const r = reg();
    expect(r.setEnabled('b', false).enabled).toBe(false);
    expect(reg().get('b')!.enabled).toBe(false);
    expect(reg(path.join(tmp, 'nowhere')).list()).toEqual([]);
    expect(new PluginRegistry(dir, { broadcast: () => {} }, '3.28.0', { keys, keyDir: path.join(tmp, 'keys') }).list()).toEqual([]);
  });
});
