import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PluginsSection } from './PluginsSection';
import { api } from '../../api/client';
import { usePluginRegistry } from '../../plugins/registry';
import * as host from '../../plugins/host';
import type { PluginRow } from '../../api/types';

const row = (id: string, extra: Partial<PluginRow> = {}): PluginRow => ({ id, name: id, version: '1.0.0', web: 'web.js', enabled: true, stamp: 1, install: null, ...extra });

let rows: PluginRow[];
let markets: { url: string; slug: string; name: string | null; description: string | null; trusted: boolean; addedAt: string; lastPulledAt: string | null; error: string | null }[];
let catalog: any[];

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
  vi.spyOn(api, 'pluginLogs').mockImplementation(async () => 'line one\nline two\n');
  markets = [];
  catalog = [];
  vi.spyOn(api, 'listMarketplaces').mockImplementation(async () => ({ marketplaces: markets }));
  vi.spyOn(api, 'addMarketplace').mockImplementation(async (url) => { if (!url.startsWith('http') && !url.startsWith('/')) throw new Error('not a marketplace url: use https://, ssh://, git@host:path, or an absolute path'); const row = { url, slug: 'm1', name: 'Test market', description: null, trusted: false, addedAt: 't', lastPulledAt: 't', error: null }; markets.push(row); return row; });
  vi.spyOn(api, 'removeMarketplace').mockImplementation(async (slug) => { markets = markets.filter((x) => x.slug !== slug); });
  vi.spyOn(api, 'pullMarketplace').mockImplementation(async (slug) => markets.find((x) => x.slug === slug)!);
  vi.spyOn(api, 'setMarketplaceTrusted').mockImplementation(async (slug, on) => { const r = markets.find((x) => x.slug === slug)!; r.trusted = on; return r; });
  vi.spyOn(api, 'pluginCatalog').mockImplementation(async () => ({ entries: catalog }));
  vi.spyOn(api, 'installPlugin').mockImplementation(async (slug, id) => { const r = row(id, { install: { marketplace: 'u', version: '1.0.0', sha256: '', installedAt: 't', commit: 'c' } }); rows.push(r); return r; });
  vi.spyOn(api, 'installSkill').mockImplementation(async () => ({ id: 'tidy', name: 'Tidy', version: '0.1.0', description: null, harnesses: null, folder: '/s', install: null, enabled: true, text: '' }));
  vi.spyOn(api, 'updatePlugin').mockImplementation(async (id) => { const r = rows.find((x) => x.id === id)!; r.version = '1.1.0'; r.install = { ...r.install!, version: '1.1.0' }; delete r.update; return r; });
  vi.spyOn(api, 'rollbackPlugin').mockImplementation(async (id) => { const r = rows.find((x) => x.id === id)!; r.version = '1.0.0'; return r; });
  vi.spyOn(api, 'pinPlugin').mockImplementation(async (id, version) => { const r = rows.find((x) => x.id === id)!; if (version) r.pinned = version; else delete r.pinned; return r; });
  vi.spyOn(api, 'setPluginAutoUpdate').mockImplementation(async (id, on) => { const r = rows.find((x) => x.id === id)!; r.autoUpdate = on; return r; });
  vi.spyOn(api, 'pluginVersions').mockImplementation(async () => ({ versions: [{ version: '1.1.0', commit: 'b', date: 't' }, { version: '1.0.0', commit: 'a', date: 't' }] }));
  vi.spyOn(api, 'restartPluginWorker').mockImplementation(async (id) => rows.find((x) => x.id === id)!.workerStats!);
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

  it('a plugin with a worker shows its state; Logs opens the tail; Restart calls the API; a crashed worker says so', async () => {
    const spec = { command: 'node', args: ['worker/index.js'], env: {}, jobs: [] };
    rows = [
      row('runner', { worker: spec, workerStats: { state: 'running', pid: 4242, restarts: 2, startedAt: '2026-11-07T10:00:00Z', lastExit: null, socket: '/tmp/s', queued: 0 } }),
      row('fallen', { worker: spec, workerStats: { state: 'crashed', pid: null, restarts: 10, startedAt: null, lastExit: { code: 1, signal: null, at: '2026-11-07T10:05:00Z' }, socket: null, queued: 0 } }),
    ];
    render(<PluginsSection />);
    const runner = await screen.findByTestId('plugin-row-runner');
    expect(within(runner).getByText(/Worker running · pid 4242 · 2 restarts/)).toBeInTheDocument();
    fireEvent.click(within(runner).getByRole('button', { name: 'Logs' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/line two/)).toBeInTheDocument();
    expect(api.pluginLogs).toHaveBeenCalledWith('runner', 200);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(within(runner).getByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(api.restartPluginWorker).toHaveBeenCalledWith('runner'));
    const fallen = screen.getByTestId('plugin-row-fallen');
    expect(within(fallen).getByText(/Worker crashed · exit 1 · 10 restarts/)).toBeInTheDocument();
    expect(within(screen.getByTestId('plugin-row-runner')).queryByText(/crashed/)).toBeNull();
  });

  it('marketplaces: add by URL, a bad URL shows the daemon\'s message, Check now and Remove call the API', async () => {
    render(<PluginsSection />);
    const section = await screen.findByRole('region', { name: 'Marketplaces' });
    fireEvent.change(within(section).getByLabelText('Marketplace URL'), { target: { value: 'nonsense' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Add marketplace' }));
    expect(await within(section).findByRole('alert')).toHaveTextContent(/not a marketplace url/);
    fireEvent.change(within(section).getByLabelText('Marketplace URL'), { target: { value: 'https://github.com/x/plugins.git' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Add marketplace' }));
    await waitFor(() => expect(api.addMarketplace).toHaveBeenCalledWith('https://github.com/x/plugins.git'));
    const rowEl = await screen.findByTestId('marketplace-m1');
    expect(rowEl).toHaveTextContent('Test market');
    fireEvent.click(within(rowEl).getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(api.pullMarketplace).toHaveBeenCalledWith('m1'));
    fireEvent.click(within(rowEl).getByRole('switch', { name: 'Trusted' }));
    await waitFor(() => expect(api.setMarketplaceTrusted).toHaveBeenCalledWith('m1', true));
    fireEvent.click(within(rowEl).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.removeMarketplace).toHaveBeenCalledWith('m1'));
  });

  it('browse lists the catalog by marketplace with Install; an installed plugin shows its version instead', async () => {
    markets = [{ url: 'u', slug: 'm1', name: 'Test market', description: null, trusted: false, addedAt: 't', lastPulledAt: 't', error: null }];
    catalog = [
      { marketplace: 'm1', kind: 'plugin', id: 'hello', name: 'The hello plugin', version: '1.0.0', description: 'hello does things', changelog: null },
      { marketplace: 'm1', kind: 'plugin', id: 'have', name: 'Have', version: '2.0.0', description: null, changelog: null, installed: { version: '2.0.0' } },
      { marketplace: 'm1', kind: 'skill', id: 'tidy', name: 'Tidy', version: '0.1.0', description: 'tidy helps', changelog: null },
      { marketplace: 'm1', kind: 'skill', id: 'have-skill', name: 'Have skill', version: '0.2.0', description: null, changelog: null, installed: { version: '0.2.0' } },
    ];
    render(<PluginsSection />);
    const browse = await screen.findByRole('region', { name: 'Browse' });
    const hello = await within(browse).findByTestId('catalog-plugin-hello');
    expect(hello).toHaveTextContent('The hello plugin');
    fireEvent.click(within(hello).getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(api.installPlugin).toHaveBeenCalledWith('m1', 'hello'));
    expect(within(browse).getByTestId('catalog-plugin-have')).toHaveTextContent('Installed v2.0.0');
    const tidy = within(browse).getByTestId('catalog-skill-tidy');
    fireEvent.click(within(tidy).getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(api.installSkill).toHaveBeenCalledWith('m1', 'tidy'));
    expect(within(browse).getByTestId('catalog-skill-have-skill')).toHaveTextContent('Installed v0.2.0');
  });

  it('an installed row shows the update with its notes, and Update, Roll back, Pin and Auto-update call the API; a gone marketplace is said', async () => {
    markets = [{ url: 'u', slug: 'm1', name: 'Test market', description: null, trusted: false, addedAt: 't', lastPulledAt: 't', error: null }];
    rows = [
      row('hello', { install: { marketplace: 'u', version: '1.0.0', sha256: '', installedAt: 't', commit: 'a' }, update: { to: '1.1.0', changelog: '## 1.1.0\n\nFaster.' }, autoUpdate: false }),
      row('orphan', { install: { marketplace: 'gone', version: '1.0.0', sha256: '', installedAt: 't', commit: 'a' }, marketplaceGone: true }),
    ];
    render(<PluginsSection />);
    const item = await screen.findByTestId('plugin-row-hello');
    expect(item).toHaveTextContent('Test market');
    expect(item).toHaveTextContent('v1.1.0 available');
    fireEvent.click(within(item).getByRole('button', { name: "What's new" }));
    expect(item).toHaveTextContent('Faster.');
    fireEvent.click(within(item).getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(api.updatePlugin).toHaveBeenCalledWith('hello'));
    await waitFor(() => expect(screen.getByTestId('plugin-row-hello')).toHaveTextContent('v1.1.0'));
    fireEvent.click(within(screen.getByTestId('plugin-row-hello')).getByRole('button', { name: 'Roll back' }));
    await waitFor(() => expect(api.rollbackPlugin).toHaveBeenCalledWith('hello'));
    fireEvent.click(within(screen.getByTestId('plugin-row-hello')).getByRole('switch', { name: 'Auto-update' }));
    await waitFor(() => expect(api.setPluginAutoUpdate).toHaveBeenCalledWith('hello', true));
    fireEvent.click(within(screen.getByTestId('plugin-row-hello')).getByRole('button', { name: 'Pin…' }));
    const pick = await within(screen.getByTestId('plugin-row-hello')).findByLabelText('Pin to version');
    fireEvent.change(pick, { target: { value: '1.0.0' } });
    await waitFor(() => expect(api.pinPlugin).toHaveBeenCalledWith('hello', '1.0.0'));
    expect(screen.getByTestId('plugin-row-orphan')).toHaveTextContent('Marketplace removed');
  });

  it('names no marketplace: Dispatch has no public one; the owner adds a marketplace by its URL', async () => {
    render(<PluginsSection />);
    const section = await screen.findByRole('region', { name: 'Marketplaces' });
    expect(section).not.toHaveTextContent(/public marketplace/i);
    expect(section).not.toHaveTextContent('polywood');
    expect(within(section).queryByRole('button', { name: 'Add it' })).toBeNull();
  });
});
