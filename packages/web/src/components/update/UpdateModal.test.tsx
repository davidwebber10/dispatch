import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { test, expect, beforeEach, vi, afterEach } from 'vitest';
afterEach(() => { vi.useRealTimers(); });

const applyUpdate = vi.fn();
const getUpdateState = vi.fn();
const getUpdateProgress = vi.fn();
vi.mock('../../api/client', () => ({ api: { applyUpdate: (force?: boolean) => applyUpdate(force), getUpdateState: () => getUpdateState(), getUpdateProgress: () => getUpdateProgress() } }));

import { UpdateModal } from './UpdateModal';
import { pageReload } from './UpdateProgress';
import { blasterActivity } from './blaster/Blaster';
import { useUpdate } from '../../stores/update';
import type { UpdateProgress } from '../../api/types';

const idle: UpdateProgress = { state: 'idle', step: null, steps: ['pull', 'install', 'build', 'tools', 'restart'], skipped: [], startedAt: null, stepStartedAt: null, error: null, version: null, finishedAt: null, log: [] };
const prog = (over: Partial<UpdateProgress>): UpdateProgress => ({ ...idle, startedAt: new Date(Date.now() - 25_000).toISOString(), stepStartedAt: new Date().toISOString(), ...over });

beforeEach(() => {
  useUpdate.setState({ available: null, currentVersion: null, dismissedVersion: null, inProgress: false, notes: [], currentNotes: null, failure: null, progress: null, progressHidden: false, runFailed: false, doneVersion: null, doneAt: null, donePlaying: false });
  pageReload.run = vi.fn();
  applyUpdate.mockReset();
  getUpdateState.mockReset();
  getUpdateProgress.mockReset();
  getUpdateProgress.mockResolvedValue(idle);
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
  expect(screen.getByText(/reloads by itself/)).toBeInTheDocument();
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

test('the game canvas is never announced', () => {
  useUpdate.setState({ available: { version: 'v1.2.0', url: null, publishedAt: null }, inProgress: true });
  const { container } = render(<UpdateModal />);
  expect(container.querySelector('canvas')).toHaveAttribute('aria-hidden', 'true');
});

test('the progress copy still reads over the game', () => {
  useUpdate.setState({ inProgress: true });
  render(<UpdateModal />);
  expect(screen.getByText('Updating Dispatch…')).toBeInTheDocument();
  expect(screen.getByText(/reloads by itself/)).toBeInTheDocument();
});

test('a canvas with no 2d context does not break the modal', () => {
  // jsdom returns null from getContext. The update screen must survive that — decoration
  // is never allowed to take down the thing the user is waiting on.
  useUpdate.setState({ inProgress: true });
  expect(() => render(<UpdateModal />)).not.toThrow();
  expect(screen.getByText('Updating Dispatch…')).toBeInTheDocument();
});

// ---- Liquid-glass progress card -----------------------------------------------------------
// While the update runs, the card sits as frosted glass IN FRONT of the terminal rain — a
// translucent, backdrop-blurred block the rain stays visible behind — instead of the opaque
// panel the idle prompt uses.
test('the in-progress card is translucent glass (backdrop blur), not the opaque panel', () => {
  useUpdate.setState({ inProgress: true });
  render(<UpdateModal />);
  const card = screen.getByText('Updating Dispatch…').closest('div[style]') as HTMLElement;
  const glass = card.closest('div[class], div')! as HTMLElement;
  // The styled card is the nearest ancestor carrying the backdrop filter.
  let node: HTMLElement | null = card;
  let found = false;
  while (node) {
    const bf = node.style.backdropFilter || (node.style as any).webkitBackdropFilter;
    if (bf && bf.includes('blur')) { found = true; expect(node.style.background).toMatch(/rgba/); break; }
    node = node.parentElement;
  }
  expect(found).toBe(true);
  void glass;
});

test('the idle "Update available" card stays an opaque panel (no backdrop blur)', () => {
  useUpdate.setState({ available: { version: 'v1.2.0', url: null, publishedAt: null }, inProgress: false });
  render(<UpdateModal />);
  let node: HTMLElement | null = screen.getByText('Update available') as HTMLElement;
  while (node) {
    const bf = node.style.backdropFilter || (node.style as any).webkitBackdropFilter;
    expect(bf || '').not.toMatch(/blur/);
    node = node.parentElement;
  }
});

test('while an update runs, the window lists the steps, marks the current one, and shows the output on request', async () => {
  getUpdateProgress.mockResolvedValue(prog({ state: 'running', step: 'build', skipped: ['install'], log: ['packages/core build$ tsc', 'packages/web build: ✓ built in 15.90s'] }));
  useUpdate.setState({ inProgress: true });
  render(<UpdateModal />);
  expect(await screen.findByText('Building')).toBeInTheDocument();
  expect(screen.getByText('Downloading')).toBeInTheDocument();
  expect(screen.getByText(/Installing packages/)).toBeInTheDocument();
  expect(screen.getByText(/skipped/)).toBeInTheDocument();
  expect(screen.getByText('Restarting')).toBeInTheDocument();
  expect(screen.getByText(/0:2\d/)).toBeInTheDocument();
  expect(screen.queryByText('packages/web build: ✓ built in 15.90s')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
  expect(screen.getByText('packages/web build: ✓ built in 15.90s')).toBeInTheDocument();
});

test('a failed update shows the step, the error and the output, with Retry and Close', async () => {
  getUpdateProgress.mockResolvedValue(prog({ state: 'failed', step: 'build', error: 'Command failed: pnpm -r run build', log: ['error TS2304: Cannot find name x'] }));
  applyUpdate.mockResolvedValue({ ok: true });
  useUpdate.setState({ inProgress: true, available: { version: 'v3.1.0', url: null, publishedAt: null } });
  render(<UpdateModal />);
  expect(await screen.findByText('Update failed')).toBeInTheDocument();
  expect(screen.getByText('Command failed: pnpm -r run build')).toBeInTheDocument();
  expect(screen.getByText('error TS2304: Cannot find name x')).toBeInTheDocument();
  expect(screen.getByText(/Dispatch still runs the old version/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(applyUpdate).toHaveBeenCalledTimes(1));
});

test('Close after a failure returns to the update prompt', async () => {
  getUpdateProgress.mockResolvedValue(prog({ state: 'failed', step: 'pull', error: 'git pull failed' }));
  useUpdate.setState({ inProgress: true, available: { version: 'v3.1.0', url: null, publishedAt: null } });
  render(<UpdateModal />);
  fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
  expect(screen.queryByText('Update failed')).toBeNull();
  expect(screen.getByText('Update available')).toBeInTheDocument();
});

test('restarting: the window says so while the server is away', async () => {
  getUpdateProgress.mockRejectedValue(new Error('fetch failed'));
  useUpdate.setState({ inProgress: true, progress: prog({ state: 'restarting', step: 'restart' }) });
  render(<UpdateModal />);
  expect(await screen.findByText(/Restarting Dispatch/)).toBeInTheDocument();
});

test('Hide closes the window; a small badge keeps showing the step and opens it again', async () => {
  getUpdateProgress.mockResolvedValue(prog({ state: 'running', step: 'tools' }));
  useUpdate.setState({ inProgress: true });
  render(<UpdateModal />);
  fireEvent.click(await screen.findByRole('button', { name: 'Hide' }));
  expect(screen.queryByText('Updating Dispatch…')).toBeNull();
  const badge = await screen.findByRole('button', { name: /Updating · Updating tools/ });
  fireEvent.click(badge);
  expect(screen.getByText('Updating Dispatch…')).toBeInTheDocument();
});

test('an update that another client started shows here too', async () => {
  getUpdateProgress.mockResolvedValue(prog({ state: 'running', step: 'pull' }));
  render(<UpdateModal />);
  expect(await screen.findByText('Updating Dispatch…')).toBeInTheDocument();
});

test('when the update is done, the card says so with Reload now and Keep playing', async () => {
  getUpdateProgress.mockResolvedValue(prog({ state: 'done', step: 'restart', version: '3.1.0' }));
  useUpdate.setState({ inProgress: true });
  render(<UpdateModal />);
  expect(await screen.findByText('Update done')).toBeInTheDocument();
  expect(screen.getByText(/Dispatch v3\.1\.0/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Reload now' }));
  expect(pageReload.run).toHaveBeenCalledTimes(1);
});

test('Keep playing hides the card; a small button reloads later', async () => {
  getUpdateProgress.mockResolvedValue(prog({ state: 'done', step: 'restart', version: '3.1.0' }));
  useUpdate.setState({ inProgress: true });
  render(<UpdateModal />);
  fireEvent.click(await screen.findByRole('button', { name: 'Keep playing' }));
  expect(screen.queryByText('Update done')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Update done · Reload/ }));
  expect(pageReload.run).toHaveBeenCalledTimes(1);
});

test('after the update is done, the page reloads by itself after 15 s with no game input', () => {
  vi.useFakeTimers();
  useUpdate.setState({ doneVersion: '3.1.0', doneAt: Date.now() });
  blasterActivity.last = 0;
  render(<UpdateModal />);
  act(() => { vi.advanceTimersByTime(14_000); });
  expect(pageReload.run).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(2_000); });
  expect(pageReload.run).toHaveBeenCalledTimes(1);
});

test('game input after the update is done keeps the page from reloading', () => {
  vi.useFakeTimers();
  useUpdate.setState({ doneVersion: '3.1.0', doneAt: Date.now() });
  render(<UpdateModal />);
  for (let k = 0; k < 4; k++) { act(() => { blasterActivity.last = Date.now(); vi.advanceTimersByTime(10_000); }); }
  expect(pageReload.run).not.toHaveBeenCalled();
});

test('the arena shows behind the running update (the game, not the rain)', async () => {
  getUpdateProgress.mockResolvedValue(prog({ state: 'running', step: 'pull' }));
  useUpdate.setState({ inProgress: true });
  render(<UpdateModal />);
  expect(await screen.findByText(/Press any key or tap to play/)).toBeInTheDocument();
});

test('a page opened during an update does not call it done when it first learns the running version', async () => {
  vi.useFakeTimers();
  getUpdateProgress.mockResolvedValue(prog({ state: 'running', step: 'build' }));
  getUpdateState.mockResolvedValue({ available: false, version: null, url: null, publishedAt: null, currentVersion: '3.0.3' });
  useUpdate.setState({ inProgress: true, currentVersion: null });
  render(<UpdateModal />);
  await act(async () => { await vi.advanceTimersByTimeAsync(7_000); });
  expect(useUpdate.getState().doneVersion).toBeNull();
  getUpdateState.mockResolvedValue({ available: false, version: null, url: null, publishedAt: null, currentVersion: '3.1.0' });
  await act(async () => { await vi.advanceTimersByTimeAsync(3_500); });
  expect(useUpdate.getState().doneVersion).toBe('3.1.0');
});
