import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePluginRegistry, useContributions, usePromotedViews, viewKey, settingsKey, isPluginView } from './registry';

const View = () => null;

beforeEach(() => {
  localStorage.clear();
  usePluginRegistry.setState({ manifests: [], status: {}, views: [], settings: [], threadMenu: [], projectMenu: [], composerActions: [], slots: [], promoted: [] });
});

describe('plugin contributions store (2026-11-07)', () => {
  it('register adds every kind under the plugin and derives keys', () => {
    usePluginRegistry.getState().register('p', {
      views: [{ id: 'v', label: 'V', Component: View }],
      settings: [{ id: 's', label: 'S', Component: View }],
      threadMenu: [{ id: 'm', label: 'M', onPick: () => {} }],
      projectMenu: [{ id: 'pm', label: 'PM', onPick: () => {} }],
      composerActions: [{ id: 'c', label: 'C', onClick: () => {} }],
      slots: [{ id: 'sl', slot: 'composer.actions', Component: View }],
    });
    const s = usePluginRegistry.getState();
    expect(s.views).toEqual([expect.objectContaining({ plugin: 'p', id: 'v', key: 'plugin:p:v' })]);
    expect(s.settings).toEqual([expect.objectContaining({ plugin: 'p', key: 'plugin:p:s' })]);
    expect(s.threadMenu[0]).toMatchObject({ plugin: 'p', id: 'm' });
    expect(s.projectMenu[0]).toMatchObject({ plugin: 'p', id: 'pm' });
    expect(s.composerActions[0]).toMatchObject({ plugin: 'p', id: 'c' });
    expect(s.slots[0]).toMatchObject({ plugin: 'p', slot: 'composer.actions' });
    expect(viewKey('p', 'v')).toBe('plugin:p:v');
    expect(settingsKey('p', 's')).toBe('plugin:p:s');
    expect(isPluginView('plugin:p:v')).toBe(true);
    expect(isPluginView('workspace')).toBe(false);
  });

  it("register again replaces that plugin's contributions only", () => {
    const reg = usePluginRegistry.getState().register;
    reg('p1', { views: [{ id: 'a', label: 'A', Component: View }, { id: 'b', label: 'B', Component: View }] });
    reg('p2', { views: [{ id: 'c', label: 'C', Component: View }] });
    reg('p1', { views: [{ id: 'a', label: 'A2', Component: View }] });
    expect(usePluginRegistry.getState().views.map((v) => [v.plugin, v.id, v.label])).toEqual([['p2', 'c', 'C'], ['p1', 'a', 'A2']]);
  });

  it('unregister drops all of one plugin', () => {
    const reg = usePluginRegistry.getState().register;
    reg('p1', { views: [{ id: 'a', label: 'A', Component: View }], composerActions: [{ id: 'c', label: 'C', onClick: () => {} }] });
    reg('p2', { views: [{ id: 'c', label: 'C', Component: View }] });
    usePluginRegistry.getState().unregister('p1');
    const s = usePluginRegistry.getState();
    expect(s.views.map((v) => v.plugin)).toEqual(['p2']);
    expect(s.composerActions).toEqual([]);
  });

  it('useContributions returns the same array for the same state (no new array per render)', () => {
    usePluginRegistry.getState().register('p', { views: [{ id: 'a', label: 'A', Component: View }] });
    const { result, rerender } = renderHook(() => useContributions('views'));
    const first = result.current;
    rerender();
    expect(Object.is(result.current, first)).toBe(true);
    const filter = (v: { id: string }) => v.id === 'a';
    const filtered = renderHook(() => useContributions('views', filter));
    const f1 = filtered.result.current;
    filtered.rerender();
    expect(Object.is(filtered.result.current, f1)).toBe(true);
    expect(f1).toHaveLength(1);
  });

  it('promoted keeps at most two keys and persists to localStorage', () => {
    act(() => usePluginRegistry.getState().setPromoted(['plugin:p:a', 'plugin:p:b', 'plugin:p:c']));
    expect(usePluginRegistry.getState().promoted).toEqual(['plugin:p:a', 'plugin:p:b']);
    expect(JSON.parse(localStorage.getItem('dispatch:plugins:promoted')!)).toEqual(['plugin:p:a', 'plugin:p:b']);
  });

  it('usePromotedViews drops a promoted key whose view is gone', () => {
    usePluginRegistry.getState().register('p', { views: [{ id: 'a', label: 'A', Component: View }] });
    act(() => usePluginRegistry.getState().setPromoted(['plugin:p:zzz', 'plugin:p:a']));
    const { result } = renderHook(() => usePromotedViews());
    expect(result.current.map((v) => v.key)).toEqual(['plugin:p:a']);
  });
});

describe('view badges (plugins slice 4)', () => {
  it('setBadge stores a count per view key, drops a zero, and anyBadge says whether any view has one', async () => {
    const { usePluginRegistry, anyBadge } = await import('./registry');
    usePluginRegistry.getState().setBadge('plugin:previews:history', 3);
    expect(usePluginRegistry.getState().badges).toEqual({ 'plugin:previews:history': 3 });
    expect(anyBadge(usePluginRegistry.getState())).toBe(true);
    usePluginRegistry.getState().setBadge('plugin:previews:history', 0);
    expect(usePluginRegistry.getState().badges).toEqual({});
    expect(anyBadge(usePluginRegistry.getState())).toBe(false);
  });

  it('unregister drops the plugin\'s badges, and setBadge with the same count keeps the same object', async () => {
    const { usePluginRegistry } = await import('./registry');
    usePluginRegistry.getState().setBadge('plugin:previews:history', 2);
    usePluginRegistry.getState().setBadge('plugin:other:v', 1);
    const before = usePluginRegistry.getState().badges;
    usePluginRegistry.getState().setBadge('plugin:previews:history', 2);
    expect(usePluginRegistry.getState().badges).toBe(before);
    usePluginRegistry.getState().unregister('previews');
    expect(usePluginRegistry.getState().badges).toEqual({ 'plugin:other:v': 1 });
  });

  it('commands register under the plugin and drop on unregister', async () => {
    const { usePluginRegistry } = await import('./registry');
    const run = () => {};
    usePluginRegistry.getState().register('p', { commands: [{ id: 'sync', label: 'Sync now', run }] });
    expect(usePluginRegistry.getState().commands).toEqual([{ plugin: 'p', id: 'sync', label: 'Sync now', run }]);
    usePluginRegistry.getState().unregister('p');
    expect(usePluginRegistry.getState().commands).toEqual([]);
  });
});
