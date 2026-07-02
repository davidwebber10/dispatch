import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { test, expect, beforeEach, vi } from 'vitest';

const applyUpdate = vi.fn();
vi.mock('../../api/client', () => ({ api: { applyUpdate: () => applyUpdate() } }));

import { UpdateBanner } from './UpdateBanner';
import { useUpdate } from '../../stores/update';

beforeEach(() => {
  useUpdate.setState({ available: null, currentVersion: null, dismissedVersion: null, inProgress: false });
  applyUpdate.mockReset();
});

test('renders nothing when no update is available', () => {
  const { container } = render(<UpdateBanner />);
  expect(container).toBeEmptyDOMElement();
});

test('shows the version, an Update action, and a Dismiss action when one is available', () => {
  useUpdate.setState({ available: { version: 'v1.2.0', url: 'https://x', publishedAt: null } });
  render(<UpdateBanner />);
  expect(screen.getByText(/A new version \(v1\.2\.0\) is available/)).toBeInTheDocument();
  expect(screen.getByText('Update')).toBeInTheDocument();
  expect(screen.getByText('Dismiss')).toBeInTheDocument();
});

test('Dismiss hides the banner for that version', () => {
  useUpdate.setState({ available: { version: 'v1.2.0', url: null, publishedAt: null } });
  render(<UpdateBanner />);
  fireEvent.click(screen.getByText('Dismiss'));
  expect(screen.queryByText(/A new version/)).not.toBeInTheDocument();
});

test('clicking Update applies the update and switches to the in-progress state', async () => {
  applyUpdate.mockResolvedValue({ ok: true });
  useUpdate.setState({ available: { version: 'v1.2.0', url: null, publishedAt: null } });
  render(<UpdateBanner />);
  fireEvent.click(screen.getByText('Update'));
  await waitFor(() => expect(screen.getByText(/Updating — Dispatch will restart/)).toBeInTheDocument());
});

test('a failed preflight falls back to showing the manual command instead of erroring silently', async () => {
  applyUpdate.mockResolvedValue({ ok: false, reason: 'Working tree has uncommitted changes.' });
  useUpdate.setState({ available: { version: 'v1.2.0', url: null, publishedAt: null } });
  render(<UpdateBanner />);
  fireEvent.click(screen.getByText('Update'));
  await waitFor(() => expect(screen.getByText(/Working tree has uncommitted changes/)).toBeInTheDocument());
  expect(screen.getByText('dispatch update')).toBeInTheDocument();
  // Still shows the banner (not dismissed / not stuck on a spinner) so the user can retry or dismiss.
  expect(screen.getByText('Update')).toBeInTheDocument();
});

test('renders the in-progress banner once another client broadcasts update:in-progress', () => {
  useUpdate.setState({ available: { version: 'v1.2.0', url: null, publishedAt: null }, inProgress: true });
  render(<UpdateBanner />);
  expect(screen.getByText(/Updating — Dispatch will restart/)).toBeInTheDocument();
});
