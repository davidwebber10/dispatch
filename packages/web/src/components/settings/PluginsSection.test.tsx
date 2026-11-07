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

/** Opens a plugin's detail page from its list row; returns the detail page. */
async function openDetail(id: string) {
  const item = await screen.findByTestId(`plugin-row-${id}`);
  fireEvent.click(within(item).getByRole('button', { name: /^Open / }));
  return screen.findByTestId(`plugin-detail-${id}`);
}
/** Back from a detail page to the list. */
const backToList = () => fireEvent.click(screen.getByRole('button', { name: 'Back to plugins' }));

describe('the Plugins list (redesign 2026-11-07)', () => {
  it('one calm row per plugin: name, a one-line description and an on/off switch; no path, permissions or button wall', async () => {
    rows = [
      row('daily-rundown', { name: 'Daily rundown', version: '0.3.0', description: 'A short summary of the day', permissions: ['read:threads'], keyed: true }),
      row('shop-one', { install: { marketplace: 'dispatchd', version: '1.0.0', sha256: 'x', installedAt: 't' } }),
      row('coach', { name: 'Coach', bundled: true }),
    ];
    usePluginRegistry.setState({ status: { 'daily-rundown': { state: 'ready', version: '0.3.0', at: 1 } } });
    render(<PluginsSection />);
    const item = await screen.findByTestId('plugin-row-daily-rundown');
    expect(item).toHaveTextContent('Daily rundown');
    expect(item).toHaveTextContent('A short summary of the day');
    expect(item).not.toHaveTextContent('~/.dispatch/plugins');
    expect(item).not.toHaveTextContent('read:threads');
    expect(item).not.toHaveTextContent('Key issued');
    expect(within(item).queryByRole('button', { name: 'Reload' })).toBeNull();
    expect(within(item).queryByRole('button', { name: 'Remove' })).toBeNull();
    // Healthy: no status mark at all.
    expect(within(item).queryByTestId('plugin-attention-daily-rundown')).toBeNull();
    // Bundled, installed and local stay as quiet groups.
    expect(within(screen.getByRole('region', { name: 'Local plugins' })).getByTestId('plugin-row-daily-rundown')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Installed plugins' })).getByTestId('plugin-row-shop-one')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Bundled plugins' })).getByTestId('plugin-row-coach')).toBeInTheDocument();
  });

  it('the switch disables and enables a plugin and refreshes the row', async () => {
    rows = [row('daily-rundown', { name: 'Daily rundown' })];
    render(<PluginsSection />);
    const sw = within(await screen.findByTestId('plugin-row-daily-rundown')).getByRole('switch', { name: 'Enable Daily rundown' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw);
    await waitFor(() => expect(api.disablePlugin).toHaveBeenCalledWith('daily-rundown'));
    await waitFor(() => expect(within(screen.getByTestId('plugin-row-daily-rundown')).getByRole('switch', { name: 'Enable Daily rundown' })).toHaveAttribute('aria-checked', 'false'));
    expect(screen.queryByTestId('plugin-detail-daily-rundown')).toBeNull();
    fireEvent.click(within(screen.getByTestId('plugin-row-daily-rundown')).getByRole('switch', { name: 'Enable Daily rundown' }));
    await waitFor(() => expect(api.enablePlugin).toHaveBeenCalledWith('daily-rundown'));
  });

  it('a row shows a status mark only when something needs attention', async () => {
    const spec = { command: 'node', args: ['w.js'], env: {}, jobs: [] };
    rows = [
      row('broken', { error: 'plugin.json is not valid JSON: x', enabled: false }),
      row('crashy'),
      row('fallen', { worker: spec, workerStats: { state: 'crashed', pid: null, restarts: 3, startedAt: null, lastExit: { code: 1, signal: null, at: 't' }, socket: null, queued: 0 } }),
      row('idle', { worker: spec }),
      row('fine', { worker: spec, workerStats: { state: 'running', pid: 1, restarts: 0, startedAt: 't', lastExit: null, socket: null, queued: 0 } }),
      row('off', { enabled: false, worker: spec }),
      row('fresh', { install: { marketplace: 'u', version: '1.0.0', sha256: '', installedAt: 't' }, update: { to: '1.1.0', changelog: null } }),
    ];
    usePluginRegistry.setState({ status: { crashy: { state: 'error', error: 'activate threw', at: 1 } } });
    render(<PluginsSection />);
    expect(await screen.findByTestId('plugin-attention-broken')).toHaveTextContent('Error');
    expect(screen.getByTestId('plugin-attention-crashy')).toHaveTextContent('Error');
    expect(screen.getByTestId('plugin-attention-fallen')).toHaveTextContent('Worker crashed');
    expect(screen.getByTestId('plugin-attention-idle')).toHaveTextContent('Worker stopped');
    expect(screen.getByTestId('plugin-attention-fresh')).toHaveTextContent('Update available');
    expect(screen.queryByTestId('plugin-attention-fine')).toBeNull();
    expect(screen.queryByTestId('plugin-attention-off')).toBeNull();
    // A broken plugin cannot be switched on.
    expect(within(screen.getByTestId('plugin-row-broken')).getByRole('switch')).toBeDisabled();
  });

  it('the intro is one plain line', async () => {
    rows = [row('coach', { bundled: true })];
    render(<PluginsSection />);
    await screen.findByTestId('plugin-row-coach');
    expect(screen.getByText('Plugins add screens and tools to Dispatch. Bundled ones update with the app.')).toBeInTheDocument();
    expect(screen.queryByText(/copy it to local to change it/)).toBeNull();
  });

  it('New plugin scaffolds and the new row appears; its folder is under Developer on its page', async () => {
    render(<PluginsSection />);
    expect(await screen.findByText(/No plugins yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New plugin…' }));
    fireEvent.change(screen.getByLabelText('Plugin id'), { target: { value: 'my-plugin' } });
    fireEvent.change(screen.getByLabelText('Plugin name'), { target: { value: 'My plugin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(api.scaffoldPlugin).toHaveBeenCalledWith('my-plugin', 'My plugin'));
    expect(await screen.findByTestId('plugin-row-my-plugin')).toHaveTextContent('My plugin');
    const detail = await openDetail('my-plugin');
    expect(within(detail).getByTestId('plugin-developer')).toHaveTextContent('~/.dispatch/plugins/my-plugin');
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

describe('a plugin detail page (redesign 2026-11-07)', () => {
  it('a tap on the row opens the page: icon, name, version, description; Back returns to the list', async () => {
    rows = [row('coach', { name: 'Coach', version: '2.1.0', description: 'Coaches your prompts', bundled: true }), row('other')];
    render(<PluginsSection />);
    const detail = await openDetail('coach');
    const header = within(detail).getByTestId('plugin-detail-header');
    expect(header).toHaveTextContent('Coach');
    expect(header).toHaveTextContent('v2.1.0');
    expect(header).toHaveTextContent('Coaches your prompts');
    expect(header).toHaveTextContent('Bundled');
    expect(screen.queryByTestId('plugin-row-other')).toBeNull();
    backToList();
    expect(await screen.findByTestId('plugin-row-other')).toBeInTheDocument();
    expect(screen.queryByTestId('plugin-detail-coach')).toBeNull();
  });

  it('the page has the same on/off switch as the row', async () => {
    rows = [row('p', { name: 'Pins' })];
    render(<PluginsSection />);
    const detail = await openDetail('p');
    fireEvent.click(within(detail).getByRole('switch', { name: 'Enable Pins' }));
    await waitFor(() => expect(api.disablePlugin).toHaveBeenCalledWith('p'));
    await waitFor(() => expect(within(screen.getByTestId('plugin-detail-p')).getByRole('switch', { name: 'Enable Pins' })).toHaveAttribute('aria-checked', 'false'));
  });

  it('permissions read as plain words with the raw id beside; unknown ids show as they are; none says so', async () => {
    rows = [
      row('coach', { permissions: ['read:prompts', 'read:threads', 'read:usage', 'model:assist', 'notify:push', 'weird:thing'] }),
      row('bare'),
    ];
    render(<PluginsSection />);
    const detail = await openDetail('coach');
    const list = within(detail).getByRole('list', { name: 'Permissions' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(6);
    expect(items[0]).toHaveTextContent('Read your prompts');
    expect(items[0]).toHaveTextContent('read:prompts');
    expect(items[1]).toHaveTextContent('Read threads');
    expect(items[2]).toHaveTextContent('Read usage');
    expect(items[3]).toHaveTextContent('Use a model on your behalf');
    expect(items[4]).toHaveTextContent('Send push notifications');
    expect(items[5]).toHaveTextContent('weird:thing');
    backToList();
    const bare = await openDetail('bare');
    expect(bare).toHaveTextContent('No permissions');
  });

  it('"Show as a phone tab" switches store the view key, at most two', async () => {
    rows = [row('a', { name: 'A' }), row('b', { name: 'B' }), row('c', { name: 'C' }), row('none', { name: 'None' })];
    const reg = usePluginRegistry.getState().register;
    reg('a', { views: [{ id: 'v', label: 'A view', Component: () => null }] });
    reg('b', { views: [{ id: 'v', label: 'B view', Component: () => null }] });
    reg('c', { views: [{ id: 'v', label: 'C view', Component: () => null }] });
    render(<PluginsSection />);
    let d = await openDetail('a');
    fireEvent.click(within(d).getByRole('switch', { name: 'Show A view as a phone tab' }));
    backToList();
    d = await openDetail('b');
    fireEvent.click(within(d).getByRole('switch', { name: 'Show B view as a phone tab' }));
    expect(usePluginRegistry.getState().promoted).toEqual(['plugin:a:v', 'plugin:b:v']);
    backToList();
    d = await openDetail('c');
    expect(within(d).getByRole('switch', { name: 'Show C view as a phone tab' })).toBeDisabled();
    expect(d).toHaveTextContent(/two tabs/i);
    backToList();
    d = await openDetail('a');
    const sw = within(d).getByRole('switch', { name: 'Show A view as a phone tab' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw);
    expect(usePluginRegistry.getState().promoted).toEqual(['plugin:b:v']);
    backToList();
    d = await openDetail('none');
    expect(within(d).queryByRole('switch', { name: /phone tab/ })).toBeNull();
  });

  it('Status shows the worker with Restart and Logs; a crashed worker and a load error say so there', async () => {
    const spec = { command: 'node', args: ['worker/index.js'], env: {}, jobs: [] };
    rows = [
      row('runner', { worker: spec, workerStats: { state: 'running', pid: 4242, restarts: 2, startedAt: '2026-11-07T10:00:00Z', lastExit: null, socket: '/tmp/s', queued: 0 } }),
      row('fallen', { worker: spec, workerStats: { state: 'crashed', pid: null, restarts: 10, startedAt: null, lastExit: { code: 1, signal: null, at: '2026-11-07T10:05:00Z' }, socket: null, queued: 0 } }),
      row('crashy'),
    ];
    usePluginRegistry.setState({ status: { crashy: { state: 'error', error: 'activate threw', at: 1 } } });
    render(<PluginsSection />);
    const runner = await openDetail('runner');
    const status = within(runner).getByRole('region', { name: 'Status' });
    expect(status).toHaveTextContent('Worker running');
    expect(status).not.toHaveTextContent('pid 4242');
    fireEvent.click(within(status).getByRole('button', { name: 'Logs' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/line two/)).toBeInTheDocument();
    expect(api.pluginLogs).toHaveBeenCalledWith('runner', 200);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(within(status).getByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(api.restartPluginWorker).toHaveBeenCalledWith('runner'));
    backToList();
    const fallen = await openDetail('fallen');
    expect(within(fallen).getByRole('region', { name: 'Status' })).toHaveTextContent(/Worker crashed · exit 1 · 10 restarts/);
    backToList();
    const crashy = await openDetail('crashy');
    expect(within(crashy).getByRole('region', { name: 'Status' })).toHaveTextContent('activate threw');
  });

  it('Status shows model calls for 7 days when the plugin has assist usage', async () => {
    rows = [row('coach', { assist: { calls: 42, failed: 2, inputTokens: 12345, outputTokens: 2100, costUsd: 0.4567, days: 7 } }), row('quiet')];
    render(<PluginsSection />);
    const coach = await openDetail('coach');
    const meter = within(coach).getByTestId('plugin-assist-coach');
    expect(meter).toHaveTextContent('Model calls, 7 days: 42 (2 failed)');
    expect(meter).toHaveTextContent('12.3k in · 2.1k out tokens');
    expect(meter).toHaveTextContent('$0.46');
    backToList();
    const quiet = await openDetail('quiet');
    expect(within(quiet).queryByTestId('plugin-assist-quiet')).toBeNull();
  });

  it('Developer is collapsed; open, it holds the path with Copy path, the pid, the key state and the manifest', async () => {
    const spec = { command: 'node', args: ['worker/index.js'], env: {}, jobs: [] };
    rows = [row('runner', { keyed: true, sdk: 1, worker: spec, workerStats: { state: 'running', pid: 4242, restarts: 0, startedAt: 't', lastExit: null, socket: null, queued: 0 } })];
    render(<PluginsSection />);
    const detail = await openDetail('runner');
    const dev = within(detail).getByTestId('plugin-developer');
    expect(dev.tagName).toBe('DETAILS');
    expect(dev).not.toHaveAttribute('open');
    fireEvent.click(within(dev).getByText('Developer'));
    expect(dev).toHaveTextContent('~/.dispatch/plugins/runner');
    expect(dev).toHaveTextContent('4242');
    expect(dev).toHaveTextContent('Key issued');
    expect(dev).toHaveTextContent('node worker/index.js');
    expect(within(dev).getByRole('button', { name: 'Copy path' })).toBeInTheDocument();
  });

  it('Reload calls the API', async () => {
    rows = [row('a')];
    render(<PluginsSection />);
    const d = await openDetail('a');
    fireEvent.click(within(d).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(api.reloadPlugin).toHaveBeenCalledWith('a'));
  });

  it('Remove asks first, then calls the API, drops the plugin and returns to the list', async () => {
    rows = [row('p'), row('q')];
    render(<PluginsSection />);
    const d = await openDetail('p');
    fireEvent.click(within(d).getByRole('button', { name: 'Remove' }));
    expect(api.removePlugin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove plugin' }));
    await waitFor(() => expect(api.removePlugin).toHaveBeenCalledWith('p', { keepData: true }));
    await waitFor(() => expect(screen.queryByTestId('plugin-detail-p')).toBeNull());
    expect(await screen.findByTestId('plugin-row-q')).toBeInTheDocument();
    expect(screen.queryByTestId('plugin-row-p')).toBeNull();
  });

  it('a plugin installed from a marketplace has Remove too; a bundled one does not', async () => {
    rows = [row('shop', { install: { marketplace: 'https://github.com/example-org/plugins.git', version: '1.0.0', sha256: 'x', installedAt: 't' } }), row('coach', { bundled: true })];
    render(<PluginsSection />);
    expect(within(await openDetail('shop')).getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    backToList();
    expect(within(await openDetail('coach')).queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('Remove keeps the plugin data unless you tick "Also delete its data"', async () => {
    rows = [row('p'), row('q')];
    render(<PluginsSection />);
    fireEvent.click(within(await openDetail('p')).getByRole('button', { name: 'Remove' }));
    const box = screen.getByRole('checkbox', { name: /Also delete its data/ });
    expect(box).not.toBeChecked();
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/kept.*install it again/i);
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Remove plugin' }));
    await waitFor(() => expect(api.removePlugin).toHaveBeenCalledWith('p', { keepData: false }));
    fireEvent.click(within(await openDetail('q')).getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('checkbox', { name: /Also delete its data/ })).not.toBeChecked();
  });

  it('the Remove dialog downloads the data and settings before you confirm, and stays open', async () => {
    rows = [row('p')];
    const exp = vi.spyOn(api, 'exportPluginData').mockResolvedValue(undefined);
    render(<PluginsSection />);
    fireEvent.click(within(await openDetail('p')).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Download data and settings' }));
    await waitFor(() => expect(exp).toHaveBeenCalledWith('p'));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(api.removePlugin).not.toHaveBeenCalled();
  });

  it('Export data downloads the data', async () => {
    rows = [row('p')];
    const exp = vi.spyOn(api, 'exportPluginData').mockResolvedValue(undefined);
    render(<PluginsSection />);
    fireEvent.click(within(await openDetail('p')).getByRole('button', { name: 'Export data' }));
    await waitFor(() => expect(exp).toHaveBeenCalledWith('p'));
  });

  it('Import data… picks a file, asks Merge or Replace (Merge by default), imports and shows the result', async () => {
    rows = [row('p', { name: 'Pins' })];
    const imp = vi.spyOn(api, 'importPluginData').mockResolvedValue({ docs: 2, files: 0, settings: true });
    render(<PluginsSection />);
    const d = await openDetail('p');
    const data = { format: 'dispatch-plugin-data', version: 1, pluginId: 'p', exportedAt: 't', settings: { a: 1 }, docs: [{ key: 'a', value: 1, updatedAt: 't' }, { key: 'b', value: 2, updatedAt: 't' }], files: [] };
    const file = new File([JSON.stringify(data)], 'p-data.json', { type: 'application/json' });
    expect(within(d).getByRole('button', { name: 'Import data…' })).toBeInTheDocument();
    fireEvent.change(within(d).getByLabelText('Import file for p'), { target: { files: [file] } });
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Import 2 documents and settings into Pins?');
    expect(within(dialog).getByRole('radio', { name: /Merge/ })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('radio', { name: /Replace/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(imp).toHaveBeenCalledWith('p', file, 'replace'));
    expect(await within(screen.getByTestId('plugin-detail-p')).findByRole('status')).toHaveTextContent('Imported 2 documents and the settings.');
  });

  it('a refused import shows the error on the page', async () => {
    rows = [row('p')];
    const imp = vi.spyOn(api, 'importPluginData').mockRejectedValue(new Error('A plugin holds at most 2000 documents; this import would make 2001.'));
    render(<PluginsSection />);
    const d = await openDetail('p');
    const file = new File([JSON.stringify({ format: 'dispatch-plugin-data', version: 1, pluginId: 'p', settings: null, docs: [], files: [] })], 'p.json');
    fireEvent.change(within(d).getByLabelText('Import file for p'), { target: { files: [file] } });
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(imp).toHaveBeenCalledWith('p', file, 'merge'));
    expect(await within(screen.getByTestId('plugin-detail-p')).findByRole('alert')).toHaveTextContent('at most 2000 documents');
  });

  it('a bundled plugin has Copy to local… that asks for an id; the copy appears in the list', async () => {
    rows = [row('prompt-coach', { name: 'Prompt coach', bundled: true })];
    render(<PluginsSection />);
    const d = await openDetail('prompt-coach');
    fireEvent.click(within(d).getByRole('button', { name: 'Copy to local…' }));
    fireEvent.change(within(d).getByLabelText('New plugin id'), { target: { value: 'my-coach' } });
    fireEvent.click(within(d).getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(api.copyPlugin).toHaveBeenCalledWith('prompt-coach', 'my-coach'));
    backToList();
    expect(await screen.findByTestId('plugin-row-my-coach')).toBeInTheDocument();
  });

  it('an installed plugin shows its update with notes, and Update, Roll back, Pin and Auto-update call the API; a gone marketplace is said', async () => {
    markets = [{ url: 'u', slug: 'm1', name: 'Test market', description: null, trusted: false, addedAt: 't', lastPulledAt: 't', error: null }];
    rows = [
      row('hello', { install: { marketplace: 'u', version: '1.0.0', sha256: '', installedAt: 't', commit: 'a' }, update: { to: '1.1.0', changelog: '## 1.1.0\n\nFaster.' }, autoUpdate: false }),
      row('orphan', { install: { marketplace: 'gone', version: '1.0.0', sha256: '', installedAt: 't', commit: 'a' }, marketplaceGone: true }),
    ];
    render(<PluginsSection />);
    await waitFor(() => expect(api.listMarketplaces).toHaveBeenCalled());
    const d = await openDetail('hello');
    await waitFor(() => expect(d).toHaveTextContent('Test market'));
    expect(d).toHaveTextContent('v1.1.0 available');
    fireEvent.click(within(d).getByRole('button', { name: "What's new" }));
    expect(d).toHaveTextContent('Faster.');
    fireEvent.click(within(d).getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(api.updatePlugin).toHaveBeenCalledWith('hello'));
    await waitFor(() => expect(within(screen.getByTestId('plugin-detail-hello')).getByTestId('plugin-detail-header')).toHaveTextContent('v1.1.0'));
    const page = () => screen.getByTestId('plugin-detail-hello');
    fireEvent.click(within(page()).getByRole('button', { name: 'Roll back' }));
    await waitFor(() => expect(api.rollbackPlugin).toHaveBeenCalledWith('hello'));
    fireEvent.click(within(page()).getByRole('switch', { name: 'Auto-update' }));
    await waitFor(() => expect(api.setPluginAutoUpdate).toHaveBeenCalledWith('hello', true));
    fireEvent.click(within(page()).getByRole('button', { name: 'Pin…' }));
    const pick = await within(page()).findByLabelText('Pin to version');
    fireEvent.change(pick, { target: { value: '1.0.0' } });
    await waitFor(() => expect(api.pinPlugin).toHaveBeenCalledWith('hello', '1.0.0'));
    backToList();
    expect(await openDetail('orphan')).toHaveTextContent('Marketplace removed');
  });
});

describe('marketplaces and browse on the Plugins page (2026-11-07)', () => {
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

  it('names no marketplace: Dispatch has no public one; the owner adds a marketplace by its URL', async () => {
    render(<PluginsSection />);
    const section = await screen.findByRole('region', { name: 'Marketplaces' });
    expect(section).not.toHaveTextContent(/public marketplace/i);
    expect(section).not.toHaveTextContent('polywood');
    expect(within(section).queryByRole('button', { name: 'Add it' })).toBeNull();
  });
});
