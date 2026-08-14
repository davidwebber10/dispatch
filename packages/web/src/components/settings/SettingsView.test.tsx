import { render, screen, fireEvent } from '@testing-library/react';
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
  for (const label of ['General', 'Integrations', 'Secrets', 'Tools', 'Transcription']) {
    expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
  }
  expect(screen.getByText('DAEMON')).toBeInTheDocument();
  expect(screen.getByText('v2.19.0')).toBeInTheDocument();
  expect(screen.getByText('Changes save as you edit')).toBeInTheDocument();
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
