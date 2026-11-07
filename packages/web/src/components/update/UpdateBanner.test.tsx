import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { test, expect, beforeEach, vi, describe } from 'vitest';

const applyUpdate = vi.fn();
const updatePlugin = vi.fn();
const pluginUpdates = vi.fn();
vi.mock('../../api/client', () => ({
  api: {
    applyUpdate: (force?: boolean) => applyUpdate(force),
    getUpdateState: vi.fn().mockResolvedValue({ available: false, version: null, url: null, publishedAt: null, currentVersion: '3.19.0' }),
    updatePlugin: (id: string) => updatePlugin(id),
    pluginUpdates: () => pluginUpdates(),
  },
}));

import { UpdateBanner } from './UpdateBanner';
import { UpdateDot } from './UpdateDot';
import { useUpdate, updatePending } from '../../stores/update';

const waiting = { available: { version: 'v3.26.1', url: 'https://example.test/v3.26.1', publishedAt: null }, currentVersion: '3.19.0', inProgress: false, doneVersion: null, failure: null };

beforeEach(() => {
  useUpdate.setState({ available: null, currentVersion: '3.19.0', dismissedVersion: null, inProgress: false, doneVersion: null, failure: null, pluginUpdates: [] });
  applyUpdate.mockReset(); updatePlugin.mockReset(); pluginUpdates.mockReset();
});

describe('updatePending (2026-11-07): one answer for the dot and the banner', () => {
  test('true only while an update is available, not running, and not done', () => {
    expect(updatePending({ available: null, inProgress: false, doneVersion: null })).toBe(false);
    expect(updatePending({ available: waiting.available, inProgress: false, doneVersion: null })).toBe(true);
    expect(updatePending({ available: waiting.available, inProgress: true, doneVersion: null })).toBe(false);
    expect(updatePending({ available: waiting.available, inProgress: false, doneVersion: '3.26.1' })).toBe(false);
  });

  test('dismissing the modal does not clear it: the dot is the reminder after the modal', () => {
    useUpdate.setState(waiting);
    useUpdate.getState().dismiss();
    expect(updatePending(useUpdate.getState())).toBe(true);
  });
});

describe('UpdateDot', () => {
  test('renders nothing when no update waits', () => {
    render(<UpdateDot />);
    expect(screen.queryByLabelText('Update available')).toBeNull();
  });

  test('a plain dot, no count, while an update waits', () => {
    useUpdate.setState(waiting);
    render(<UpdateDot />);
    const dot = screen.getByLabelText('Update available');
    expect(dot.textContent).toBe('');
  });
});

describe('UpdateBanner', () => {
  test('renders nothing when no update waits', () => {
    render(<UpdateBanner />);
    expect(screen.queryByRole('region', { name: 'Update available' })).toBeNull();
  });

  test('names the new version, the one running, the notes, and applies on Update now', async () => {
    useUpdate.setState(waiting);
    applyUpdate.mockResolvedValue({ ok: true });
    render(<UpdateBanner />);
    expect(screen.getByText('Dispatch v3.26.1 is available')).toBeInTheDocument();
    expect(screen.getByText('You run v3.19.0.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Release notes' })).toHaveAttribute('href', 'https://example.test/v3.26.1');
    fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
    await waitFor(() => expect(applyUpdate).toHaveBeenCalledWith(undefined));
    // Once the update runs, the progress window takes over and the banner leaves.
    await waitFor(() => expect(useUpdate.getState().inProgress).toBe(true));
    expect(screen.queryByRole('region', { name: 'Update available' })).toBeNull();
  });

  test('a version without the v prefix still reads as one', () => {
    useUpdate.setState({ ...waiting, available: { ...waiting.available, version: '3.26.1' } });
    render(<UpdateBanner />);
    expect(screen.getByText('Dispatch v3.26.1 is available')).toBeInTheDocument();
  });

  test('a preflight refusal shows its reason under the row', async () => {
    useUpdate.setState(waiting);
    applyUpdate.mockResolvedValue({ ok: false, reason: 'the checkout has local changes' });
    render(<UpdateBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
    await screen.findByText(/the checkout has local changes/);
    expect(screen.getByText(/dispatch update/)).toBeInTheDocument();
  });
});

describe('plugin updates in the dot and the banner (plugins slice 6)', () => {
  const hello = { id: 'hello', name: 'The hello plugin', marketplace: 'm', from: '1.0.0', to: '1.1.0', changelog: '## 1.1.0\n\nFaster.' };
  test('updatePending is true with plugin updates alone', () => {
    expect(updatePending({ available: null, inProgress: false, doneVersion: null, pluginUpdates: [hello] })).toBe(true);
    expect(updatePending({ available: null, inProgress: false, doneVersion: null, pluginUpdates: [] })).toBe(false);
  });
  test('the banner lists plugin updates under the Dispatch one; Update calls the API and is disabled while one runs', async () => {
    let release: () => void = () => {};
    updatePlugin.mockImplementation(() => new Promise<void>((r) => { release = r; }));
    pluginUpdates.mockResolvedValue({ updates: [] });
    useUpdate.setState({ ...waiting, pluginUpdates: [hello, { ...hello, id: 'other', name: 'Other' }] });
    render(<UpdateBanner />);
    expect(screen.getByText(/Dispatch v3.26.1 is available/)).toBeInTheDocument();
    const region = screen.getByRole('region', { name: 'Plugin updates' });
    expect(region).toHaveTextContent('The hello plugin 1.0.0 → 1.1.0');
    const buttons = screen.getAllByRole('button', { name: /^Update (The hello plugin|Other)$/ });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(updatePlugin).toHaveBeenCalledWith('hello'));
    expect(buttons[0]).toBeDisabled();
    expect(buttons[1]).toBeDisabled();
    fireEvent.click(buttons[1]);
    expect(updatePlugin).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(pluginUpdates).toHaveBeenCalled());
  });
  test('the dot shows for plugin updates alone', () => {
    useUpdate.setState({ pluginUpdates: [hello] });
    render(<UpdateDot />);
    expect(screen.getByRole('status', { name: 'Update available' })).toBeInTheDocument();
  });
});
