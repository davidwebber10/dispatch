import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginRegistry } from '../../src/plugins/registry.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('PluginRegistry', () => {
  let tmp: string;
  let dir: string;
  let events: Record<string, unknown>[];
  const reg = (running = '3.28.0') => new PluginRegistry(dir, { broadcast: (e) => { events.push(e); } }, running);
  const plugin = (id: string, manifest: Record<string, unknown> | string, web = 'export default () => {}') => {
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    fs.writeFileSync(path.join(dir, id, 'plugin.json'), typeof manifest === 'string' ? manifest : JSON.stringify({ id, name: id, version: '1.0.0', web: 'web.js', ...manifest }));
    fs.writeFileSync(path.join(dir, id, 'web.js'), web);
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-'));
    dir = path.join(tmp, 'plugins');
    events = [];
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
    expect(reg().get('shop')?.install).toEqual({ marketplace: 'dispatchd', version: '1.0.0', sha256: 'abc', installedAt: '2026-11-07T00:00:00Z' });
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

  it('remove deletes a local plugin and refuses one with an install record', () => {
    plugin('local', {}); plugin('shop', {});
    fs.writeFileSync(path.join(dir, 'shop', '.dispatch-install.json'), '{"marketplace":"m","version":"1","sha256":"x","installedAt":"t"}');
    const r = reg();
    r.remove('local');
    expect(fs.existsSync(path.join(dir, 'local'))).toBe(false);
    expect(() => r.remove('shop')).toThrow('not local');
    expect(() => r.remove('nope')).toThrow('unknown plugin');
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
      const changes = events.filter((e) => e.type === 'plugin:changed');
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ id: 'p', plugin: expect.objectContaining({ id: 'p' }) });
      events.length = 0;
      fs.rmSync(path.join(dir, 'p'), { recursive: true });
      await sleep(400);
      expect(events.filter((e) => e.type === 'plugin:changed')).toEqual([{ type: 'plugin:changed', id: 'p', plugin: null }]);
    } finally { r.stop(); }
  });
});
