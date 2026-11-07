import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AccountsSection } from './AccountsSection';
import { codexLoginTiming } from './CodexLogin';
import { api } from '../../api/client';
import { useProjects } from '../../stores/projects';
import { useTabs } from '../../stores/tabs';
import { useUI } from '../../stores/ui';
import type { AccountsView } from '../../api/types';

const view = (): AccountsView => ({
  claude: [{ id: 'cli', label: 'CLI login (this computer)', isCli: true, addedAt: null }, { id: 'w1', label: 'Work', email: 'me@work.com', plan: 'Max', isCli: false, addedAt: '2026-11-06T00:00:00Z' }],
  codex: [{ id: 'cli', label: 'CLI login (this computer)', isCli: true, addedAt: null }, { id: 'p9', label: 'Personal', isCli: false, addedAt: '2026-11-06T00:00:00Z', signedIn: false }],
  defaults: { claude: 'w1', codex: 'cli' },
});

beforeEach(() => {
  vi.spyOn(api, 'getAccounts').mockResolvedValue(view());
  useProjects.setState({ sessions: [{ id: 'P', name: 'Proj', workingDir: '/p' }] as any, activeId: 'P' } as any);
  vi.spyOn(useTabs.getState(), 'loadTabs').mockResolvedValue(undefined as any);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('<AccountsSection>', () => {
  it('lists every account under its harness with email, plan, the default, and the sign-in state', async () => {
    render(<AccountsSection />);
    expect(await screen.findByText('Work')).toBeInTheDocument();
    expect(screen.getByText(/me@work.com · Max/)).toBeInTheDocument();
    expect(screen.getByTestId('account-claude-w1')).toHaveTextContent('default');
    expect(screen.getByTestId('account-codex-p9')).toHaveTextContent('not signed in yet');
    expect(screen.queryByRole('button', { name: 'Remove CLI login (this computer)' })).toBeNull(); // the CLI login stays
  });

  it('makes another account the default; removing one names the threads that revert to the default', async () => {
    const setDefault = vi.spyOn(api, 'accountsSetDefault').mockResolvedValue({ claude: 'cli', codex: 'cli' });
    const remove = vi.spyOn(api, 'accountsRemove').mockResolvedValue({ unpinned: 2 });
    vi.spyOn(api, 'accountsThreads').mockResolvedValue([{ id: 't1', label: 'Fix login', sessionId: 'P' }, { id: 't2', label: 'Docs', sessionId: 'P' }]);
    render(<AccountsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Make CLI login (this computer) the default' }));
    await waitFor(() => expect(setDefault).toHaveBeenCalledWith('claude', 'cli'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Work' }));
    const notice = await screen.findByText(/2 threads run on "Work": "Fix login", "Docs"\. They will use "CLI login \(this computer\)" the next time they start\./);
    expect(notice).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('claude', 'w1'));
  });

  it('renames an account in place (2026-11-06)', async () => {
    const rename = vi.spyOn(api, 'accountsRename').mockResolvedValue(view());
    render(<AccountsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Work' }));
    const input = screen.getByLabelText('New name') as HTMLInputElement;
    expect(input.value).toBe('Work');
    fireEvent.change(input, { target: { value: 'Side' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(rename).toHaveBeenCalledWith('claude', 'w1', 'Side'));
  });

  it('shows the thread count under an account that threads are pinned to', async () => {
    const v = view();
    v.claude[1].threadCount = 3;
    vi.spyOn(api, 'getAccounts').mockResolvedValue(v);
    render(<AccountsSection />);
    expect(await screen.findByText(/me@work.com · Max · 3 threads/)).toBeInTheDocument();
  });

  it('adding a Codex account makes its folder and signs it in right here with the device code (no thread, nothing to paste)', async () => {
    codexLoginTiming.pollMs = 10;
    vi.spyOn(api, 'accountsAddCodex').mockResolvedValue({ id: 'n1', label: 'Second' });
    const login = vi.spyOn(api, 'accountsCodexLogin').mockResolvedValue({ accountId: 'n1', status: 'awaiting_user', url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345', error: null, createdAt: 'x' });
    vi.spyOn(api, 'accountsCodexLoginStatus').mockResolvedValue({ accountId: 'n1', status: 'complete', url: null, code: null, error: null, createdAt: 'x' });
    const create = vi.spyOn(api, 'createTerminal');
    render(<AccountsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add Codex account' }));
    fireEvent.change(screen.getByLabelText('Account name'), { target: { value: 'Second' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add and sign in' }));
    await waitFor(() => expect(login).toHaveBeenCalledWith('n1'));
    // Complete: the panel closes and the list reloads.
    await waitFor(() => expect(screen.queryByLabelText('Account name')).toBeNull());
    expect(create).not.toHaveBeenCalled();
    codexLoginTiming.pollMs = 2000;
  });

  it('a Codex account with no login offers Sign in again, which starts the device sign-in for it', async () => {
    const login = vi.spyOn(api, 'accountsCodexLogin').mockResolvedValue({ accountId: 'p9', status: 'awaiting_user', url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345', error: null, createdAt: 'x' });
    vi.spyOn(api, 'accountsCodexLoginStatus').mockResolvedValue({ accountId: 'p9', status: 'awaiting_user', url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345', error: null, createdAt: 'x' });
    render(<AccountsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in again to Personal' }));
    await waitFor(() => expect(login).toHaveBeenCalledWith('p9'));
    expect(await screen.findByText('ABCD-12345')).toBeInTheDocument();
    // Only an account with no login gets it: the CLI login and signed-in accounts do not.
    expect(screen.queryByRole('button', { name: /Sign in again to CLI login/ })).toBeNull();
  });

  it('adding a Claude account starts the headless login for a new account', async () => {
    const start = vi.spyOn(api, 'accountsClaudeLogin').mockResolvedValue({ id: 'l1', status: 'awaiting_code', url: 'https://claude.ai/x', error: null, createdAt: 'x' });
    render(<AccountsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add Claude account' }));
    fireEvent.change(screen.getByLabelText('Account name'), { target: { value: 'Side' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in to the new Claude account' }));
    await waitFor(() => expect(start).toHaveBeenCalledWith('Side'));
    expect(await screen.findByText(/Open the Claude login page/)).toBeInTheDocument();
  });
});
