import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { usePluginRegistry } from './registry';
import { loadPlugins, reloadPlugin, applyPluginEvent, isSafeMode } from './host';
import { installSdk, type DispatchSdk } from './sdk';
import type { PluginRow } from '../api/types';

const row = (id: string, extra: Partial<PluginRow> = {}): PluginRow => ({ id, name: id, version: '1.0.0', web: 'web.js', enabled: true, stamp: 100, install: null, ...extra });

function fakeFetch(rows: PluginRow[]) {
  return vi.fn(async (url: string) => ({ ok: true, json: async () => ({ plugins: rows }), status: 200, url }));
}

beforeEach(() => {
  localStorage.clear();
  usePluginRegistry.setState({ manifests: [], status: {}, views: [], settings: [], threadMenu: [], projectMenu: [], composerActions: [], slots: [], promoted: [] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('plugin host (2026-11-07)', () => {
  it('loadPlugins imports each enabled bundle with ?v=<stamp> and marks it ready', async () => {
    vi.stubGlobal('fetch', fakeFetch([row('a', { stamp: 7 }), row('b', { stamp: 9 })]));
    const urls: string[] = [];
    const importer = async (url: string) => {
      urls.push(url);
      const id = /plugins\/([^/]+)\//.exec(url)![1];
      return { default: (d: DispatchSdk) => d.register(id, { views: [{ id: 'v', label: id, Component: () => null }] }) };
    };
    await loadPlugins(importer);
    expect(urls).toEqual(['/plugins/a/web.js?v=7', '/plugins/b/web.js?v=9']);
    const s = usePluginRegistry.getState();
    expect(s.manifests.map((m) => m.id)).toEqual(['a', 'b']);
    expect(s.views.map((v) => v.key)).toEqual(['plugin:a:v', 'plugin:b:v']);
    expect(s.status.a.state).toBe('ready');
    expect(s.status.b).toMatchObject({ state: 'ready', version: '1.0.0' });
  });

  it("a disabled row and a broken row are not imported; the broken one's error is its status; a row without web is ready at once", async () => {
    vi.stubGlobal('fetch', fakeFetch([row('off', { enabled: false }), row('broken', { error: 'plugin.json is not valid JSON: x', enabled: false }), row('noweb', { web: undefined })]));
    const importer = vi.fn(async () => ({ default: () => {} }));
    await loadPlugins(importer);
    expect(importer).not.toHaveBeenCalled();
    const s = usePluginRegistry.getState();
    expect(s.status.broken).toMatchObject({ state: 'error', error: 'plugin.json is not valid JSON: x' });
    expect(s.status.off).toMatchObject({ state: 'error', error: 'disabled' });
    expect(s.status.noweb.state).toBe('ready');
  });

  it("one plugin's throw does not block the next", async () => {
    vi.stubGlobal('fetch', fakeFetch([row('p1'), row('p2')]));
    const importer = async (url: string) => {
      if (url.includes('/p1/')) throw new Error('syntax error in p1');
      return { default: (d: DispatchSdk) => d.register('p2', { views: [{ id: 'v', label: 'P2', Component: () => null }] }) };
    };
    await loadPlugins(importer);
    const s = usePluginRegistry.getState();
    expect(s.status.p1).toMatchObject({ state: 'error', error: 'syntax error in p1' });
    expect(s.status.p2.state).toBe('ready');
    expect(s.views.map((v) => v.plugin)).toEqual(['p2']);
  });

  it('an activate that throws after registering leaves no contributions behind', async () => {
    vi.stubGlobal('fetch', fakeFetch([row('p')]));
    const importer = async () => ({ default: (d: DispatchSdk) => { d.register('p', { views: [{ id: 'v', label: 'V', Component: () => null }] }); throw new Error('late'); } });
    await loadPlugins(importer);
    expect(usePluginRegistry.getState().views).toEqual([]);
    expect(usePluginRegistry.getState().status.p).toMatchObject({ state: 'error', error: 'late' });
  });

  it('safe mode loads nothing', async () => {
    localStorage.setItem('dispatch:plugins:safe', '1');
    expect(isSafeMode()).toBe(true);
    const fetch = fakeFetch([row('a')]);
    vi.stubGlobal('fetch', fetch);
    const importer = vi.fn(async () => ({ default: () => {} }));
    await loadPlugins(importer);
    expect(fetch).not.toHaveBeenCalled();
    expect(importer).not.toHaveBeenCalled();
    expect(usePluginRegistry.getState().manifests).toEqual([]);
  });

  it('a failed manifest fetch leaves the registry untouched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const importer = vi.fn(async () => ({ default: () => {} }));
    await loadPlugins(importer);
    expect(importer).not.toHaveBeenCalled();
  });

  it('applyPluginEvent reloads a changed plugin with the new stamp and unregisters a removed one', async () => {
    vi.stubGlobal('fetch', fakeFetch([row('a', { stamp: 1 })]));
    const urls: string[] = [];
    const importer = async (url: string) => { urls.push(url); return { default: (d: DispatchSdk) => d.register('a', { views: [{ id: 'v', label: url, Component: () => null }] }) }; };
    await loadPlugins(importer);
    applyPluginEvent({ type: 'plugin:changed', id: 'a', plugin: row('a', { stamp: 2, version: '1.1.0' }) }, importer);
    await vi.waitFor(() => expect(urls).toEqual(['/plugins/a/web.js?v=1', '/plugins/a/web.js?v=2']));
    const s = usePluginRegistry.getState();
    expect(s.views[0].label).toBe('/plugins/a/web.js?v=2');
    expect(s.manifests[0].version).toBe('1.1.0');
    expect(s.status.a.version).toBe('1.1.0');
    applyPluginEvent({ type: 'plugin:changed', id: 'a', plugin: null }, importer);
    expect(usePluginRegistry.getState().views).toEqual([]);
    expect(usePluginRegistry.getState().manifests).toEqual([]);
  });

  it('applyPluginEvent for a plugin that was disabled unregisters it without importing', async () => {
    vi.stubGlobal('fetch', fakeFetch([row('a')]));
    const importer = vi.fn(async () => ({ default: (d: DispatchSdk) => d.register('a', { views: [{ id: 'v', label: 'A', Component: () => null }] }) }));
    await loadPlugins(importer);
    expect(usePluginRegistry.getState().views).toHaveLength(1);
    applyPluginEvent({ type: 'plugin:changed', id: 'a', plugin: row('a', { enabled: false }) }, importer);
    expect(usePluginRegistry.getState().views).toEqual([]);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('reloadPlugin unregisters before it imports, so a bundle that now registers less leaves nothing stale', async () => {
    let n = 0;
    const importer = async () => ({ default: (d: DispatchSdk) => { n++; d.register('a', { views: n === 1 ? [{ id: 'v1', label: '1', Component: () => null }, { id: 'v2', label: '2', Component: () => null }] : [{ id: 'v1', label: '1', Component: () => null }] }); } });
    await reloadPlugin(row('a'), importer);
    expect(usePluginRegistry.getState().views).toHaveLength(2);
    await reloadPlugin(row('a', { stamp: 101 }), importer);
    expect(usePluginRegistry.getState().views.map((v) => v.id)).toEqual(['v1']);
  });

  it('installSdk puts one object on window.dispatch and keeps it across calls', () => {
    const a = installSdk();
    expect(window.dispatch).toBe(a);
    expect(installSdk()).toBe(a);
    expect(typeof a.register).toBe('function');
    expect(typeof a.h).toBe('function');
    expect(a.icons.puzzle).toBeDefined();
  });
});
