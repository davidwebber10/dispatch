import { render, screen, fireEvent } from '@testing-library/react';
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

test('shows the running version', () => {
  render(<UpdatesSection />);
  expect(screen.getByText('Dispatch v2.10.0')).toBeInTheDocument();
});

test('offers the notes for the version you already run when nothing is pending', () => {
  useUpdate.setState({ currentNotes: '# Dispatch v2.10.0 — sidebar limits\n\nWhat shipped.' });
  render(<UpdatesSection />);
  fireEvent.click(screen.getByText("What's new in v2.10.0"));
  expect(screen.getByText('sidebar limits')).toBeInTheDocument();
  expect(screen.getByText('What shipped.')).toBeInTheDocument();
});

test('shows the pending update\'s notes instead, once one is available', () => {
  useUpdate.setState({
    available: { version: 'v2.11.0', url: null, publishedAt: null },
    currentNotes: '# Dispatch v2.10.0 — old\n\nOld body.',
    notes: [{ version: 'v2.11.0', url: 'u', publishedAt: '2026-08-13T00:00:00Z', notes: '# Dispatch v2.11.0 — new\n\nNew body.' }],
  });
  render(<UpdatesSection />);
  fireEvent.click(screen.getByText('Release notes'));
  expect(screen.getByText('New body.')).toBeInTheDocument();
  expect(screen.queryByText('Old body.')).not.toBeInTheDocument();
});

test('shows no notes row at all when the daemon reported none', () => {
  render(<UpdatesSection />);
  expect(screen.queryByText(/Release notes|What's new/)).not.toBeInTheDocument();
});
