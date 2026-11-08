import { render, screen, fireEvent, within } from '@testing-library/react';
import { test, expect, beforeEach, vi } from 'vitest';

const applyUpdate = vi.fn();
const getUpdateState = vi.fn();
vi.mock('../../api/client', () => ({
  api: {
    applyUpdate: (force?: boolean) => applyUpdate(force),
    getUpdateState: () => getUpdateState(),
    checkUpdate: () => getUpdateState(),
  },
}));

import { UpdatesSection } from './UpdatesSection';
import { useUpdate } from '../../stores/update';

beforeEach(() => {
  useUpdate.setState({ available: null, currentVersion: '2.10.0', dismissedVersion: null, inProgress: false, notes: [], currentNotes: null });
  applyUpdate.mockReset();
  getUpdateState.mockReset();
  getUpdateState.mockResolvedValue({ available: false, version: null, url: null, publishedAt: null, currentVersion: '2.10.0' });
});

const versionGroup = () => screen.getByRole('group', { name: 'Dispatch' });

test('shows the running version as a value row in the Dispatch group', () => {
  render(<UpdatesSection />);
  const row = within(versionGroup()).getByText('Version').closest('[data-testid="settings-row"]') as HTMLElement;
  expect(row).toHaveTextContent('v2.10.0');
});

test('checks for updates from a row with one button, and says when you are up to date', async () => {
  render(<UpdatesSection />);
  fireEvent.click(within(versionGroup()).getByRole('button', { name: 'Check now' }));
  expect(await screen.findByText("You're up to date.")).toBeInTheDocument();
});

test('an available update is a row with Update now', () => {
  useUpdate.setState({ available: { version: 'v2.11.0', url: null, publishedAt: null } });
  render(<UpdatesSection />);
  expect(within(versionGroup()).getByText('v2.11.0 is available')).toBeInTheDocument();
  expect(within(versionGroup()).getByRole('button', { name: 'Update now' })).toBeInTheDocument();
});

test('offers the notes for the version you already run when nothing is pending: one line, the rest in a sheet', () => {
  useUpdate.setState({ currentNotes: '# Dispatch v2.10.0 — sidebar limits\n\nWhat shipped.' });
  render(<UpdatesSection />);
  const row = within(versionGroup()).getByRole('button', { name: "What's new in v2.10.0" });
  // One line of what changed; the body only if you ask for it.
  expect(screen.getByText('sidebar limits')).toBeInTheDocument();
  expect(screen.queryByText('What shipped.')).not.toBeInTheDocument();
  fireEvent.click(row);
  expect(within(screen.getByRole('dialog', { name: "What's new in v2.10.0" })).getByText('What shipped.')).toBeInTheDocument();
});

test("shows the pending update's notes instead, once one is available", () => {
  useUpdate.setState({
    available: { version: 'v2.11.0', url: null, publishedAt: null },
    currentNotes: '# Dispatch v2.10.0 — old\n\nOld body.',
    notes: [{ version: 'v2.11.0', url: 'u', publishedAt: '2026-08-13T00:00:00Z', notes: '# Dispatch v2.11.0 — new\n\nNew body.' }],
  });
  render(<UpdatesSection />);
  expect(screen.getByText('new')).toBeInTheDocument();
  expect(screen.queryByText('old')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Release notes' }));
  expect(within(screen.getByRole('dialog', { name: 'Release notes' })).getByText('New body.')).toBeInTheDocument();
});

test('shows no notes row at all when the daemon reported none', () => {
  render(<UpdatesSection />);
  expect(screen.queryByText(/Release notes|What's new/)).not.toBeInTheDocument();
});
