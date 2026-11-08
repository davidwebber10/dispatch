import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { beforeEach, afterEach, vi, test, expect } from 'vitest';
import { SettingsView } from './SettingsView';
import { IconRail } from '../layout/IconRail';
import { useUI } from '../../stores/ui';
import { useUpdate } from '../../stores/update';
import { usePluginRegistry } from '../../plugins/registry';

beforeEach(() => {
  // The section bodies load their own data on mount; a resolved empty fetch keeps
  // jsdom quiet without stubbing each store.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] }));
  useUpdate.setState({ currentVersion: '2.19.0' });
  useUI.setState({ view: 'workspace' });
});
afterEach(() => vi.unstubAllGlobals());

test('renders the section nav and the autosave footer, without the daemon block or the shortcut hint (2026-11-07)', () => {
  render(<SettingsView />);
  for (const label of ['Appearance', 'Notifications', 'Dictation', 'Agents', 'Accounts', 'Usage limits', 'Integrations', 'Secrets', 'Tools', 'Devices & access', 'Servers', 'Plugins', 'Skills', 'About & updates']) {
    expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
  }
  expect(screen.queryByRole('button', { name: 'General' })).toBeNull();
  // The connection now shows in Settings → Servers, the version in About & updates.
  expect(screen.queryByText('DAEMON')).toBeNull();
  expect(screen.queryByText('⌘, to reopen')).toBeNull();
  expect(screen.getByText('Changes save as you edit')).toBeInTheDocument();
});

test('the nav is grouped YOU / AGENTS / THIS MAC, each holding its sections', () => {
  render(<SettingsView />);
  const names = (g: string) => within(screen.getByRole('group', { name: g })).getAllByRole('button').map((b) => b.textContent);
  expect(names('YOU')).toEqual(['Appearance', 'Notifications', 'Dictation']);
  expect(names('AGENTS')).toEqual(['Agents', 'Accounts', 'Usage limits', 'Integrations', 'Secrets', 'Tools']);
  expect(names('THIS MAC')).toEqual(['Devices & access', 'Servers', 'Plugins', 'Skills', 'About & updates']);
});

const title = () => screen.getByTestId('settings-content-title');

test('opens on Appearance, and a deep link opens its section (old keys still work)', () => {
  render(<SettingsView />);
  expect(title()).toHaveTextContent('Appearance');
  act(() => { useUI.getState().requestSettings('dictation'); });
  expect(title()).toHaveTextContent('Dictation');
  act(() => { useUI.getState().requestSettings('agents'); });
  act(() => { useUI.getState().requestSettings('transcription'); });
  expect(title()).toHaveTextContent('Dictation');
  expect(useUI.getState().pendingSettingsSection).toBeNull();
});

test('selecting a section swaps the content header: the title alone, no blurb beside it (2026-11-07)', () => {
  render(<SettingsView />);
  fireEvent.click(screen.getByRole('button', { name: 'Secrets' }));
  expect(title()).toHaveTextContent(/^Secrets$/);
  expect(screen.getByRole('button', { name: 'Secrets' })).toHaveAttribute('aria-current', 'page');
  expect(screen.queryByText('Doppler environment variables')).toBeNull();
});

test('the rail Settings item and ⌘, both navigate to the settings view', () => {
  render(<IconRail />);
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  expect(useUI.getState().view).toBe('settings');

  useUI.setState({ view: 'workspace' });
  fireEvent.keyDown(window, { key: ',', metaKey: true });
  expect(useUI.getState().view).toBe('settings');
});

test('an update that waits heads the page above every section, and dots the rail (2026-11-07)', () => {
  useUpdate.setState({ available: { version: 'v3.26.1', url: null, publishedAt: null }, inProgress: false, doneVersion: null });
  render(<><IconRail /><SettingsView /></>);
  expect(screen.getByRole('region', { name: 'Update available' })).toBeInTheDocument();
  expect(screen.getByText('Dispatch v3.26.1 is available')).toBeInTheDocument();
  expect(within(screen.getByRole('button', { name: /Settings/ })).getByLabelText('Update available')).toBeInTheDocument();
  // Another section keeps the banner.
  fireEvent.click(screen.getByRole('button', { name: 'Secrets' }));
  expect(screen.getByRole('button', { name: 'Update now' })).toBeInTheDocument();
  useUpdate.setState({ available: null });
});

test('a plugin settings section shows under PLUGINS on desktop and opens; the group is absent with no plugin (2026-11-07)', () => {
  usePluginRegistry.setState({ settings: [] });
  const { unmount } = render(<SettingsView />);
  expect(screen.queryByRole('group', { name: 'PLUGINS' })).toBeNull();
  unmount();
  usePluginRegistry.getState().register('daily-rundown', { settings: [{ id: 'rundown', label: 'Daily rundown', blurb: 'How far back', icon: 'sun', Component: () => <div>rundown settings body</div> }] });
  render(<SettingsView />);
  const group = screen.getByRole('group', { name: 'PLUGINS' });
  fireEvent.click(within(group).getByRole('button', { name: 'Daily rundown' }));
  expect(screen.getByText('rundown settings body')).toBeInTheDocument();
  expect(title()).toHaveTextContent('Daily rundown');
  usePluginRegistry.getState().unregister('daily-rundown');
});

test('a plugin section that throws shows the boundary card inside Settings (2026-11-07)', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  usePluginRegistry.getState().register('bad', { settings: [{ id: 's', label: 'Bad section', blurb: '', Component: () => { throw new Error('section boom'); } }] });
  render(<SettingsView />);
  fireEvent.click(screen.getByRole('button', { name: 'Bad section' }));
  expect(screen.getByRole('alert')).toHaveTextContent('The plugin "bad" failed');
  expect(screen.getByRole('group', { name: 'THIS MAC' })).toBeInTheDocument();
  usePluginRegistry.getState().unregister('bad');
  spy.mockRestore();
});
