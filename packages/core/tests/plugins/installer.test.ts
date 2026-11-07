import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { MarketplaceService } from '../../src/plugins/marketplaces.js';
import { PluginInstaller } from '../../src/plugins/installer.js';
import { KeyRegistry } from '../../src/auth/principals.js';
import { makeMarket } from './market-fixture.js';

/** Install, update, roll back, pin, auto-update (docs/superpowers/specs/2026-11-07-plugins-design.md, section 7.2). */
describe('PluginInstaller', () => {
  let tmp: string; let m: ReturnType<typeof makeMarket>; let reg: PluginRegistry; let mkt: MarketplaceService; let events: Record<string, unknown>[]; let slug: string;
  const build = (opts: { copy?: (from: string, to: string) => void } = {}) => new PluginInstaller(reg, mkt, path.join(tmp, 'plugins'), '3.27.0', path.join(tmp, 'installer.json'), opts);
  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-'));
    m = makeMarket();
    events = [];
    reg = new PluginRegistry(path.join(tmp, 'plugins'), { broadcast: (e) => { events.push(e); } }, '3.27.0', { keys: new KeyRegistry(), keyDir: path.join(tmp, 'keys'), bundledDir: path.join(tmp, 'bundled') });
    fs.mkdirSync(path.join(tmp, 'bundled', 'previews'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'bundled', 'previews', 'plugin.json'), JSON.stringify({ id: 'previews', name: 'Previews', version: '1.0.0', enabledByDefault: true }));
    mkt = new MarketplaceService(path.join(tmp, 'marketplaces'), path.join(tmp, 'marketplaces.json'));
    slug = (await mkt.add(m.url)).slug;
  });
  afterEach(() => { m.rm(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('install copies the plugin, writes the install file with the commit, and enables it; a bundled or local id, a bad dispatch range, and an unknown id are refused', async () => {
    const inst = build();
    const row = await inst.install(slug, 'hello');
    expect(row).toMatchObject({ id: 'hello', version: '1.0.0', enabled: true, keyed: true, install: { marketplace: m.url, version: '1.0.0', commit: m.first } });
    expect(fs.existsSync(path.join(tmp, 'plugins', 'hello', 'web.js'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'plugins', 'hello', '.dispatch-install.json'))).toBe(true);
    expect(events.some((e) => e.type === 'plugin:changed' && e.id === 'hello')).toBe(true);
    await expect(inst.install(slug, 'hello')).rejects.toThrow(/already installed/);
    await expect(inst.install(slug, 'previews')).rejects.toThrow(/bundled|exists/);
    await expect(inst.install(slug, 'nope')).rejects.toThrow(/not in the marketplace/);
    m.plugin('future', '1.0.0', { dispatch: '>=99.0' }); m.commit('future');
    await expect(inst.install(slug, 'future')).rejects.toThrow(/needs Dispatch >=99.0/);
    m.plugin('newsdk', '1.0.0', { sdk: 9 }); m.commit('newsdk');
    await expect(inst.install(slug, 'newsdk')).rejects.toThrow(/SDK 9/);
  });

  it('updates lists a newer version with its changelog; a pin hides it; update swaps the folder, keeps .prev, broadcasts plugin:updated, and the row shows the new version', async () => {
    const inst = build();
    await inst.install(slug, 'hello');
    expect(await inst.updates()).toEqual([]);
    m.plugin('hello', '1.1.0'); const second = m.commit('bump');
    await mkt.pull(slug);
    const ups = await inst.updates();
    expect(ups).toEqual([{ id: 'hello', name: 'The hello plugin', marketplace: slug, from: '1.0.0', to: '1.1.0', changelog: expect.stringContaining('The 1.1.0 notes') }]);
    expect(reg.get('hello')).toMatchObject({ update: { to: '1.1.0' } });
    inst.pin('hello', '1.0.0');
    expect(await inst.updates()).toEqual([]);
    expect(reg.get('hello')!.pinned).toBe('1.0.0');
    inst.pin('hello', null);
    const row = await inst.update('hello');
    expect(row).toMatchObject({ version: '1.1.0', install: { version: '1.1.0', commit: second } });
    expect(fs.existsSync(path.join(tmp, 'plugins', 'hello.prev', 'web.js'))).toBe(true);
    expect(fs.readFileSync(path.join(tmp, 'plugins', 'hello', 'web.js'), 'utf8')).toContain('V 1.1.0');
    expect(events.find((e) => e.type === 'plugin:updated')).toEqual({ type: 'plugin:updated', id: 'hello', from: '1.0.0', to: '1.1.0' });
    expect(await inst.updates()).toEqual([]);
    expect(reg.list().map((r) => r.id)).toEqual(['hello', 'previews']); // .prev is not a plugin
  });

  it('a failed update keeps the old folder', async () => {
    const inst = build({ copy: () => { throw new Error('disk full'); } });
    const good = build();
    await good.install(slug, 'hello');
    m.plugin('hello', '1.1.0'); m.commit('bump'); await mkt.pull(slug);
    await expect(inst.update('hello')).rejects.toThrow(/disk full/);
    expect(reg.get('hello')!.version).toBe('1.0.0');
    expect(fs.readFileSync(path.join(tmp, 'plugins', 'hello', 'web.js'), 'utf8')).toContain('V 1.0.0');
    expect(fs.existsSync(path.join(tmp, 'plugins', 'hello.staging'))).toBe(false);
  });

  it('rollback swaps .prev back and refuses when there is none', async () => {
    const inst = build();
    await inst.install(slug, 'hello');
    await expect(inst.rollback('hello')).rejects.toThrow(/nothing to roll back/);
    m.plugin('hello', '1.1.0'); m.commit('bump'); await mkt.pull(slug);
    await inst.update('hello');
    const row = await inst.rollback('hello');
    expect(row.version).toBe('1.0.0');
    expect(fs.readFileSync(path.join(tmp, 'plugins', 'hello', 'web.js'), 'utf8')).toContain('V 1.0.0');
    expect(events.filter((e) => e.type === 'plugin:updated').at(-1)).toMatchObject({ from: '1.1.0', to: '1.0.0' });
    // Rolling back again goes forward to the version that was replaced.
    expect((await inst.rollback('hello')).version).toBe('1.1.0');
  });

  it('auto-update applies to plugins switched on, and to every plugin of a trusted marketplace', async () => {
    const inst = build();
    await inst.install(slug, 'hello');
    m.plugin('other', '1.0.0'); m.commit('other'); await mkt.pull(slug);
    await inst.install(slug, 'other');
    m.plugin('hello', '1.1.0'); m.plugin('other', '1.1.0'); m.commit('bumps');
    inst.setAutoUpdate('hello', true);
    expect(reg.get('hello')!.autoUpdate).toBe(true);
    const applied = await inst.checkNow();
    expect(applied.updated).toEqual(['hello']);
    expect(reg.get('hello')!.version).toBe('1.1.0');
    expect(reg.get('other')!.version).toBe('1.0.0');
    expect(applied.updates.map((u) => u.id)).toEqual(['other']);
    expect(events.filter((e) => e.type === 'plugin:updates').at(-1)).toMatchObject({ updates: [expect.objectContaining({ id: 'other' })] });
    mkt.setTrusted(slug, true);
    expect((await inst.checkNow()).updated).toEqual(['other']);
    expect(reg.get('other')!.version).toBe('1.1.0');
  });
});
