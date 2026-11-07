import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PluginsSection } from './PluginsSection';
import { api } from '../../api/client';
import { usePluginRegistry } from '../../plugins/registry';
import * as host from '../../plugins/host';
import type { PluginRow } from '../../api/types';

const row = (id: string, extra: Partial<PluginRow> = {}): PluginRow => ({ id, name: id, version: '1.0.0', web: 'web.js', enabled: true, stamp: 1, install: null, ...extra });

let rows: PluginRow[];

beforeEach(() => {
  localStorage.clear();
  rows = [];
  usePluginRegistry.setState({ manifests: [], status: {}, views: [], settings: [], threadMenu: [], projectMenu: [], composerActions: [], slots: [], promoted: [] });
  vi.spyOn(api, 'listPlugins').mockImplementation(async () => ({ plugins: rows }));
  vi.spyOn(api, 'enablePlugin').mockImplementation(async (id) => { const r = rows.find((x) => x.id === id)!; r.enabled = true; return r; });
  vi.spyOn(api, 'disablePlugin').mockImplementation(async (id) => { const r = rows.find((x) => x.id === id)!; r.enabled = false; return r; });
  vi.spyOn(api, 'scaffoldPlugin').mockImplementation(async (id, name) => { const r = row(id, { name, version: '0.1.0' }); rows.push(r); return r; });
  vi.spyOn(api, 'removePlugin').mockImplementation(async (id) => { rows = rows.filter((x) => x.id !== id); });
  vi.spyOn(api, 'reloadPlugin').mockImplementation(async (id) => rows.find((x) => x.id === id)!);
  vi.spyOn(api, 'copyPlugin').mockImplementation(async (id, newId) => { const src = rows.find((x) => x.id === id)!; const r = row(newId, { name: src.name }); rows.push(r); return r; });
  vi.spyOn(host, 'reloadPlugin').mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('Settings → Plugins (2026-11-07)', () => {
  it('lists local plugins with state, and Disable / Enable call the API and refresh the row', async () => {
    rows = [row('daily-rundown', { name: 'Daily rundown', version: '0.3.0' }), row('shop-one', { install: { marketplace: 'dispatchd', version: '1.0.0', sha256: 'x', installedAt: 't' } })];
    usePluginRegistry.setState({ status: { 'daily-rundown': { state: 'ready', version: '0.3.0', at: 1 } } });
    render(<PluginsSection />);
    const item = await screen.findByTestId('plugin-row-daily-rundown');
    expect(item).toHaveTextContent('Daily rundown');
    expect(item).toHaveTextContent('v0.3.0');
    expect(item).toHaveTextContent('Ready');
    expect(within(screen.getByRole('region', { name: 'Local plugins' })).queryByTestId('plugin-row-shop-one')).toBeNull();
    expect(screen.getByRole('region', { name: 'Installed plugins' })).toHaveTextContent('shop-one');
    fireEvent.click(within(item).getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(api.disablePlugin).toHaveBeenCalledWith('daily-rundown'));
    await waitFor(() => expect(within(screen.getByTestId('plugin-row-daily-rundown')).getByRole('button', { name: 'Enable' })).toBeInTheDocument());
    expect(screen.getByTestId('plugin-row-daily-rundown')).toHaveTextContent('Disabled');
  });

  it('New plugin scaffolds and the new row appears', async () => {
    render(<PluginsSection />);
    expect(await screen.findByText(/No plugins yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New plugin…' }));
    fireEvent.change(screen.getByLabelText('Plugin id'), { target: { value: 'my-plugin' } });
    fireEvent.change(screen.getByLabelText('Plugin name'), { target: { value: 'My plugin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(api.scaffoldPlugin).toHaveBeenCalledWith('my-plugin', 'My plugin'));
    expect(await screen.findByTestId('plugin-row-my-plugin')).toHaveTextContent('My plugin');
    expect(screen.getByTestId('plugin-row-my-plugin')).toHaveTextContent('~/.dispatch/plugins/my-plugin');
  });

  it('Remove asks first, then calls the API and drops the row', async () => {
    rows = [row('p')];
    render(<PluginsSection />);
    const item = await screen.findByTestId('plugin-row-p');
    fireEvent.click(within(item).getByRole('button', { name: 'Remove' }));
    expect(api.removePlugin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove plugin' }));
    await waitFor(() => expect(api.removePlugin).toHaveBeenCalledWith('p'));
    await waitFor(() => expect(screen.queryByTestId('plugin-row-p')).toBeNull());
  });

  it('a broken plugin shows its error, and a plugin whose bundle failed shows that', async () => {
    rows = [row('broken', { error: 'plugin.json is not valid JSON: x', enabled: false }), row('crashy')];
    usePluginRegistry.setState({ status: { crashy: { state: 'error', error: 'activate threw', at: 1 } } });
    render(<PluginsSection />);
    expect(await screen.findByTestId('plugin-row-broken')).toHaveTextContent('plugin.json is not valid JSON: x');
    expect(screen.getByTestId('plugin-row-crashy')).toHaveTextContent('activate threw');
  });

  it('Promote to a tab stores the view key, at most two; Reload calls the API', async () => {
    rows = [row('a'), row('b'), row('c')];
    const reg = usePluginRegistry.getState().register;
    reg('a', { views: [{ id: 'v', label: 'A view', Component: () => null }] });
    reg('b', { views: [{ id: 'v', label: 'B view', Component: () => null }] });
    reg('c', { views: [{ id: 'v', label: 'C view', Component: () => null }] });
    render(<PluginsSection />);
    const a = await screen.findByTestId('plugin-row-a');
    fireEvent.click(within(a).getByRole('button', { name: 'Promote A view to a tab' }));
    fireEvent.click(within(screen.getByTestId('plugin-row-b')).getByRole('button', { name: 'Promote B view to a tab' }));
    expect(usePluginRegistry.getState().promoted).toEqual(['plugin:a:v', 'plugin:b:v']);
    expect(within(screen.getByTestId('plugin-row-c')).getByRole('button', { name: 'Promote C view to a tab' })).toBeDisabled();
    fireEvent.click(within(screen.getByTestId('plugin-row-a')).getByRole('button', { name: 'Remove the tab for A view' }));
    expect(usePluginRegistry.getState().promoted).toEqual(['plugin:b:v']);
    fireEvent.click(within(screen.getByTestId('plugin-row-a')).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(api.reloadPlugin).toHaveBeenCalledWith('a'));
  });

  it('the safe-mode switch writes the flag and says to reload', async () => {
    render(<PluginsSection />);
    const sw = await screen.findByRole('switch', { name: 'Safe mode' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(sw);
    expect(localStorage.getItem('dispatch:plugins:safe')).toBe('1');
    expect(screen.getByText(/Reload the app to apply/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Safe mode' }));
    expect(localStorage.getItem('dispatch:plugins:safe')).toBeNull();
  });
});

describe('permissions on the Plugins page (2026-11-07)', () => {
  it("a row lists the plugin's permissions with their meaning, says when there are none, and shows the key state", async () => {
    rows = [row('reader', { permissions: ['read:threads', 'notify'], keyed: true } as Partial<PluginRow>), row('bare', { keyed: false } as Partial<PluginRow>)];
    render(<PluginsSection />);
    const reader = await screen.findByTestId('plugin-row-reader');
    const chips = within(reader).getByRole('list', { name: 'Permissions' });
    expect(within(chips).getByTitle(/threads and transcripts/i)).toHaveTextContent('read:threads');
    expect(within(chips).getByText('notify')).toBeInTheDocument();
    expect(reader).toHaveTextContent('Key issued');
    const bare = screen.getByTestId('plugin-row-bare');
    expect(bare).toHaveTextContent('No permissions');
    expect(bare).not.toHaveTextContent('Key issued');
  });
});

describe('bundled plugins on the Plugins page (2026-11-07)', () => {
  it('a bundled plugin shows under BUNDLED with no Remove and a Copy to local that asks for an id', async () => {
    rows = [row('prompt-coach', { name: 'Prompt coach', bundled: true } as Partial<PluginRow>)];
    render(<PluginsSection />);
    const item = await screen.findByTestId('plugin-row-prompt-coach');
    expect(within(screen.getByRole('region', { name: 'Bundled plugins' })).getByTestId('plugin-row-prompt-coach')).toBeInTheDocument();
    expect(item).toHaveTextContent('Bundled');
    expect(within(item).queryByRole('button', { name: 'Remove' })).toBeNull();
    fireEvent.click(within(item).getByRole('button', { name: 'Copy to local…' }));
    fireEvent.change(within(item).getByLabelText('New plugin id'), { target: { value: 'my-coach' } });
    fireEvent.click(within(item).getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(api.copyPlugin).toHaveBeenCalledWith('prompt-coach', 'my-coach'));
    expect(await screen.findByTestId('plugin-row-my-coach')).toBeInTheDocument();
  });
});
