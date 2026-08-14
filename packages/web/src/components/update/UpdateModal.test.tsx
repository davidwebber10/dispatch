import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { test, expect, beforeEach, vi } from 'vitest';

const applyUpdate = vi.fn();
const getUpdateState = vi.fn();
vi.mock('../../api/client', () => ({ api: { applyUpdate: (force?: boolean) => applyUpdate(force), getUpdateState: () => getUpdateState() } }));

import { UpdateModal } from './UpdateModal';
import { useUpdate } from '../../stores/update';

beforeEach(() => {
  useUpdate.setState({ available: null, currentVersion: null, dismissedVersion: null, inProgress: false, notes: [], currentNotes: null });
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

test('a dirty-tree failure lists the dirty paths, an overflow line, and an Update anyway button', async () => {
  applyUpdate.mockResolvedValue({
    ok: false,
    reason: 'Working tree has uncommitted changes.',
    dirty: [{ status: ' M', path: 'a.ts' }, { status: '??', path: 'b.ts' }],
    dirtyOverflow: 3,
    forceable: true,
  });
  useUpdate.setState({ available: { version: 'v1.2.0', url: null, publishedAt: null } });
  render(<UpdateModal />);
  fireEvent.click(screen.getByText('Update'));
  await waitFor(() => expect(screen.getByText(/a\.ts/)).toBeInTheDocument());
  expect(screen.getByText(/b\.ts/)).toBeInTheDocument();
  expect(screen.getByText('+3 more')).toBeInTheDocument();
  expect(screen.getByText('Update anyway')).toBeInTheDocument();
});

test('clicking Update anyway re-applies with force=true', async () => {
  applyUpdate.mockResolvedValue({
    ok: false,
    reason: 'Working tree has uncommitted changes.',
    dirty: [{ status: ' M', path: 'a.ts' }],
    forceable: true,
  });
  useUpdate.setState({ available: { version: 'v1.2.0', url: null, publishedAt: null } });
  render(<UpdateModal />);
  fireEvent.click(screen.getByText('Update'));
  await waitFor(() => expect(screen.getByText('Update anyway')).toBeInTheDocument());
  fireEvent.click(screen.getByText('Update anyway'));
  await waitFor(() => expect(applyUpdate).toHaveBeenLastCalledWith(true));
});

test('no Update anyway button when the preflight failure is not forceable', async () => {
  applyUpdate.mockResolvedValue({ ok: false, reason: 'git fetch failed: network unreachable.' });
  useUpdate.setState({ available: { version: 'v1.2.0', url: null, publishedAt: null } });
  render(<UpdateModal />);
  fireEvent.click(screen.getByText('Update'));
  await waitFor(() => expect(screen.getByText(/network unreachable/)).toBeInTheDocument());
  expect(screen.queryByText('Update anyway')).not.toBeInTheDocument();
});

test('offers a collapsed Release notes row, and expands it in place', () => {
  useUpdate.setState({
    available: { version: 'v1.2.0', url: null, publishedAt: null },
    currentVersion: '1.1.0',
    notes: [{ version: 'v1.2.0', url: 'u', publishedAt: '2026-08-01T00:00:00Z', notes: '# Dispatch v1.2.0 — the headline\n\nWhat changed.' }],
  });
  render(<UpdateModal />);
  expect(screen.queryByText('What changed.')).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('Release notes'));
  // A single line of what changed, not the whole note.
  expect(screen.getByText('the headline')).toBeInTheDocument();
  expect(screen.queryByText('What changed.')).not.toBeInTheDocument();
  // The Update action stays reachable with the notes open.
  expect(screen.getByText('Update')).toBeInTheDocument();
});

test('shows no Release notes row when the server sent none', () => {
  useUpdate.setState({ available: { version: 'v1.2.0', url: null, publishedAt: null }, notes: [] });
  render(<UpdateModal />);
  expect(screen.queryByText('Release notes')).not.toBeInTheDocument();
});

test('expanding the notes does not dismiss the modal', () => {
  useUpdate.setState({
    available: { version: 'v1.2.0', url: null, publishedAt: null },
    notes: [{ version: 'v1.2.0', url: 'u', publishedAt: null as unknown as string, notes: 'Body.' }],
  });
  render(<UpdateModal />);
  fireEvent.click(screen.getByText('Release notes'));
  expect(screen.getByText('Update available')).toBeInTheDocument();
});

test('draws the rain only while an update is actually running', () => {
  useUpdate.setState({ available: { version: 'v1.2.0', url: null, publishedAt: null } });
  const { container, rerender } = render(<UpdateModal />);
  // Update available, not started: no canvas burning frames in the background.
  expect(container.querySelector('canvas')).toBeNull();

  useUpdate.setState({ inProgress: true });
  rerender(<UpdateModal />);
  expect(container.querySelector('canvas')).not.toBeNull();
});

test('the rain is decorative and never announced', () => {
  useUpdate.setState({ available: { version: 'v1.2.0', url: null, publishedAt: null }, inProgress: true });
  const { container } = render(<UpdateModal />);
  expect(container.querySelector('canvas')).toHaveAttribute('aria-hidden', 'true');
});

test('the progress copy still reads over the rain', () => {
  useUpdate.setState({ inProgress: true });
  render(<UpdateModal />);
  expect(screen.getByText('Updating Dispatch…')).toBeInTheDocument();
  expect(screen.getByText(/refresh automatically/)).toBeInTheDocument();
});

test('a canvas with no 2d context does not break the modal', () => {
  // jsdom returns null from getContext. The update screen must survive that — decoration
  // is never allowed to take down the thing the user is waiting on.
  useUpdate.setState({ inProgress: true });
  expect(() => render(<UpdateModal />)).not.toThrow();
  expect(screen.getByText('Updating Dispatch…')).toBeInTheDocument();
});
