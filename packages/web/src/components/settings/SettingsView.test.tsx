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

test('renders the section nav, the daemon block, and the autosave footer', () => {
  render(<SettingsView />);
  for (const label of ['Appearance', 'Notifications', 'Dictation', 'Agents', 'Accounts', 'Usage limits', 'Integrations', 'Secrets', 'Tools', 'Devices & access', 'Servers', 'Plugins', 'Skills', 'About & updates']) {
    expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
  }
  expect(screen.queryByRole('button', { name: 'General' })).toBeNull();
  expect(screen.getByText('DAEMON')).toBeInTheDocument();
  expect(screen.getByText('v2.19.0')).toBeInTheDocument();
  expect(screen.getByText('Changes save as you edit')).toBeInTheDocument();
});

test('the nav is grouped YOU / AGENTS / THIS MAC, each holding its sections', () => {
  render(<SettingsView />);
  const names = (g: string) => within(screen.getByRole('group', { name: g })).getAllByRole('button').map((b) => b.textContent);
  expect(names('YOU')).toEqual(['Appearance', 'Notifications', 'Dictation']);
  expect(names('AGENTS')).toEqual(['Agents', 'Accounts', 'Usage limits', 'Integrations', 'Secrets', 'Tools']);
  expect(names('THIS MAC')).toEqual(['Devices & access', 'Servers', 'Plugins', 'Skills', 'About & updates']);
});

test('opens on Appearance, and a deep link opens its section (old keys still work)', () => {
  render(<SettingsView />);
  expect(screen.getByText('Theme, accent, text sizes, density, layout')).toBeInTheDocument();
  act(() => { useUI.getState().requestSettings('dictation'); });
  expect(screen.getByText('Speech-to-text provider and key')).toBeInTheDocument();
  act(() => { useUI.getState().requestSettings('transcription'); });
  expect(screen.getByText('Speech-to-text provider and key')).toBeInTheDocument();
  expect(useUI.getState().pendingSettingsSection).toBeNull();
});

test('selecting a section swaps the content header', () => {
  render(<SettingsView />);
  fireEvent.click(screen.getByRole('button', { name: 'Secrets' }));
  // The label now shows twice: the nav item and the content header title.
  expect(screen.getAllByText('Secrets').length).toBeGreaterThanOrEqual(2);
  expect(screen.getByText('Doppler environment variables')).toBeInTheDocument();
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
  expect(screen.getByText('How far back')).toBeInTheDocument();
  usePluginRegistry.getState().unregister('daily-rundown');
});

test('a plugin section that throws shows the boundary card inside Settings (2026-11-07)', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  usePluginRegistry.getState().register('bad', { settings: [{ id: 's', label: 'Bad section', blurb: '', Component: () => { throw new Error('section boom'); } }] });
  render(<SettingsView />);
  fireEvent.click(screen.getByRole('button', { name: 'Bad section' }));
  expect(screen.getByRole('alert')).toHaveTextContent('The plugin "bad" failed');
  expect(screen.getByText('DAEMON')).toBeInTheDocument();
  usePluginRegistry.getState().unregister('bad');
  spy.mockRestore();
});
