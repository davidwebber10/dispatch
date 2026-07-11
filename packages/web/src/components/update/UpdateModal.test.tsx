import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { test, expect, beforeEach, vi } from 'vitest';

const applyUpdate = vi.fn();
const getUpdateState = vi.fn();
vi.mock('../../api/client', () => ({ api: { applyUpdate: () => applyUpdate(), getUpdateState: () => getUpdateState() } }));

import { UpdateModal } from './UpdateModal';
import { useUpdate } from '../../stores/update';

beforeEach(() => {
  useUpdate.setState({ available: null, currentVersion: null, dismissedVersion: null, inProgress: false });
  applyUpdate.mockReset();
  getUpdateState.mockReset();
  getUpdateState.mockResolvedValue({ available: false, version: null, url: null, publishedAt: null, currentVersion: '1.0.0' });
});

test('renders nothing when no update is available', () => {
  const { container } = render(<UpdateModal />);
  expect(container).toBeEmptyDOMElement();
});

test('shows the version, an Update action, and a Later action when one is available', () => {
  useUpdate.setState({ available: { version: 'v1.2.0', url: 'https://x', publishedAt: null }, currentVersion: '1.1.0' });
  render(<UpdateModal />);
  expect(screen.getByText('Update available')).toBeInTheDocument();
  expect(screen.getByText(/Dispatch v1\.2\.0 is ready to install/)).toBeInTheDocument();
  expect(screen.getByText(/you're on v1\.1\.0/)).toBeInTheDocument();
  expect(screen.getByText('Update')).toBeInTheDocument();
  expect(screen.getByText('Later')).toBeInTheDocument();
});

test('Later dismisses the modal for that version', () => {
  useUpdate.setState({ available: { version: 'v1.2.0', url: null, publishedAt: null } });
  render(<UpdateModal />);
  fireEvent.click(screen.getByText('Later'));
  expect(screen.queryByText('Update available')).not.toBeInTheDocument();
});

test('tapping the backdrop dismisses the modal too', () => {
  useUpdate.setState({ available: { version: 'v1.2.0', url: null, publishedAt: null } });
  const { container } = render(<UpdateModal />);
  fireEvent.click(container.firstChild as Element);
  expect(screen.queryByText('Update available')).not.toBeInTheDocument();
});

test('clicking Update applies the update and switches to the in-progress state', async () => {
  applyUpdate.mockResolvedValue({ ok: true });
  useUpdate.setState({ available: { version: 'v1.2.0', url: null, publishedAt: null } });
  render(<UpdateModal />);
  fireEvent.click(screen.getByText('Update'));
  await waitFor(() => expect(screen.getByText(/Updating Dispatch/)).toBeInTheDocument());
  expect(screen.getByText(/refresh automatically/)).toBeInTheDocument();
});

test('a failed preflight falls back to showing the manual command instead of erroring silently', async () => {
  applyUpdate.mockResolvedValue({ ok: false, reason: 'Working tree has uncommitted changes.' });
  useUpdate.setState({ available: { version: 'v1.2.0', url: null, publishedAt: null } });
  render(<UpdateModal />);
  fireEvent.click(screen.getByText('Update'));
  await waitFor(() => expect(screen.getByText(/Working tree has uncommitted changes/)).toBeInTheDocument());
  expect(screen.getByText('dispatch update')).toBeInTheDocument();
  // Still shows the modal (not dismissed / not stuck on a spinner) so the user can retry or dismiss.
  expect(screen.getByText('Update')).toBeInTheDocument();
});

test('renders the in-progress state once another client broadcasts update:in-progress', () => {
  useUpdate.setState({ available: { version: 'v1.2.0', url: null, publishedAt: null }, inProgress: true });
  render(<UpdateModal />);
  expect(screen.getByText(/Updating Dispatch/)).toBeInTheDocument();
});
