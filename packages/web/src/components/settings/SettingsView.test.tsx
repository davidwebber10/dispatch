import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { beforeEach, afterEach, vi, test, expect } from 'vitest';
import { SettingsView } from './SettingsView';
import { IconRail } from '../layout/IconRail';
import { useUI } from '../../stores/ui';
import { useUpdate } from '../../stores/update';

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
  for (const label of ['Appearance', 'Notifications', 'Dictation', 'Agents', 'Accounts', 'Usage limits', 'Integrations', 'Secrets', 'Tools', 'Devices & access', 'Servers', 'About & updates']) {
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
  expect(names('THIS MAC')).toEqual(['Devices & access', 'Servers', 'About & updates']);
});

test('opens on Appearance, and a deep link opens its section (old keys still work)', () => {
  render(<SettingsView />);
  expect(screen.getByText('Accent, text sizes, density, layout')).toBeInTheDocument();
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
