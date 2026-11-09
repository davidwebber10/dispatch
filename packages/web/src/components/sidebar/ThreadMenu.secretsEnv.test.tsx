import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ThreadMenu } from './ThreadMenu';
import { usePluginRegistry } from '../../plugins/registry';
import { useSecrets } from '../../stores/secrets';
import { useTabs } from '../../stores/tabs';
import { useHint } from '../../stores/hint';
import { api } from '../../api/client';
import * as push from '../../lib/push';
import type { Terminal } from '../../api/types';

// W1-C (engineering program v4.5.0): one switch in the thread menu, "Doppler token in this
// thread's shell". It exists only when the owner chose "only threads that I turn on".

const tab = (over: Partial<Terminal> = {}): Terminal => ({ id: 't1', sessionId: 's1', type: 'claude-code', label: 'Fix the login bug', config: {}, status: 'waiting', createdAt: '2026-11-07T00:00:00Z', ...over } as Terminal);
const status = (tokenScope: 'all' | 'opted-in', connected = true) => ({ connected, project: 'acme', config: 'dev', enabled: true, readOnly: false, tokenScope });
const NAME = "Doppler token in this thread's shell";

function viewport(phone: boolean) {
  Object.defineProperty(window, 'innerWidth', { value: phone ? 390 : 1440, configurable: true, writable: true });
  Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true, writable: true });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: phone, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
}

const open = (t: Terminal = tab(), onClose = () => {}) => render(<ThreadMenu at={{ tab: t, x: 40, y: 60 }} onClose={onClose} onBranched={() => {}} />);
const openMore = () => fireEvent.click(screen.getByRole('button', { name: 'More' }));

beforeEach(() => {
  usePluginRegistry.setState({ views: [], settings: [], threadMenu: [], projectMenu: [], composerActions: [], slots: [], promoted: [], manifests: [], status: {} });
  useSecrets.setState({ status: null, secrets: [], projects: [], configs: [] });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));
  vi.spyOn(push, 'canReceiveAlerts').mockReturnValue(true);
  vi.spyOn(api, 'listSecrets').mockResolvedValue([]);
  viewport(false);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('the thread menu Doppler token switch', () => {
  it('the switch is hidden when the scope is all', async () => {
    const get = vi.spyOn(api, 'getSecretsStatus').mockResolvedValue(status('all'));
    open();
    await waitFor(() => expect(get).toHaveBeenCalled());
    openMore();
    expect(screen.getByRole('button', { name: 'Auto-archive…' })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: NAME })).toBeNull();
  });

  it('is hidden while Doppler is not connected, and when the status cannot be read', async () => {
    const get = vi.spyOn(api, 'getSecretsStatus').mockResolvedValue(status('opted-in', false));
    const first = open();
    await waitFor(() => expect(get).toHaveBeenCalled());
    openMore();
    expect(screen.queryByRole('switch', { name: NAME })).toBeNull();
    first.unmount();
    get.mockRejectedValue(new Error('offline'));
    open();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    openMore();
    expect(screen.queryByRole('switch', { name: NAME })).toBeNull();
  });

  it('with scope opted-in it shows in More, off, with a Phosphor icon and a plain line', async () => {
    vi.spyOn(api, 'getSecretsStatus').mockResolvedValue(status('opted-in'));
    open();
    openMore();
    const sw = await screen.findByRole('switch', { name: NAME });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(sw.querySelector('svg')).not.toBeNull();
    expect(sw).toHaveTextContent(/doppler run/);
    // The status read for the menu does not load the secret list.
    expect(api.listSecrets).not.toHaveBeenCalled();
  });

  it('reads the thread config: on when secretsEnv is true', async () => {
    vi.spyOn(api, 'getSecretsStatus').mockResolvedValue(status('opted-in'));
    open(tab({ config: { secretsEnv: true } }));
    openMore();
    expect(await screen.findByRole('switch', { name: NAME })).toHaveAttribute('aria-checked', 'true');
  });

  it('a click saves the switch for this thread, reloads the tabs and says when it applies', async () => {
    vi.spyOn(api, 'getSecretsStatus').mockResolvedValue(status('opted-in'));
    const put = vi.spyOn(api, 'setThreadSecretsEnv').mockResolvedValue({ id: 't1', secretsEnv: true, appliesAt: 'next-spawn', message: 'x' });
    const loadTabs = vi.fn(async () => {});
    useTabs.setState({ loadTabs } as never);
    const show = vi.fn();
    useHint.setState({ show } as never);
    const onClose = vi.fn();
    open(tab(), onClose);
    openMore();
    fireEvent.click(await screen.findByRole('switch', { name: NAME }));
    expect(onClose).toHaveBeenCalled();
    await waitFor(() => expect(put).toHaveBeenCalledWith('t1', true));
    await waitFor(() => expect(loadTabs).toHaveBeenCalledWith('s1'));
    expect(show).toHaveBeenCalledWith(expect.stringMatching(/Reload the thread/));
  });

  it('a click on a thread that has it on turns it off', async () => {
    vi.spyOn(api, 'getSecretsStatus').mockResolvedValue(status('opted-in'));
    const put = vi.spyOn(api, 'setThreadSecretsEnv').mockResolvedValue({ id: 't1', secretsEnv: false, appliesAt: 'next-spawn', message: 'x' });
    open(tab({ config: { secretsEnv: true } }));
    openMore();
    fireEvent.click(await screen.findByRole('switch', { name: NAME }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('t1', false));
  });

  it('a failed save says so', async () => {
    vi.spyOn(api, 'getSecretsStatus').mockResolvedValue(status('opted-in'));
    vi.spyOn(api, 'setThreadSecretsEnv').mockRejectedValue(new Error('403'));
    const show = vi.fn();
    useHint.setState({ show } as never);
    open();
    openMore();
    fireEvent.click(await screen.findByRole('switch', { name: NAME }));
    await waitFor(() => expect(show).toHaveBeenCalledWith('Could not change the Doppler token switch'));
  });

  it('is not offered where the token cannot reach the thread: a Codex Pretty thread and a file tab', async () => {
    const get = vi.spyOn(api, 'getSecretsStatus').mockResolvedValue(status('opted-in'));
    const first = open(tab({ type: 'codex', config: { transport: 'structured' } }));
    await waitFor(() => expect(get).toHaveBeenCalled());
    openMore();
    expect(screen.queryByRole('switch', { name: NAME })).toBeNull();
    first.unmount();
    // A Codex CLI thread has its own process: the switch is there.
    open(tab({ type: 'codex', config: {} }));
    openMore();
    expect(await screen.findByRole('switch', { name: NAME })).toBeInTheDocument();
  });

  it('shows in the phone sheet too', async () => {
    viewport(true);
    vi.spyOn(api, 'getSecretsStatus').mockResolvedValue(status('opted-in'));
    open();
    openMore();
    expect(await screen.findByRole('switch', { name: NAME })).toBeInTheDocument();
  });
});
