import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AccountsSection } from './AccountsSection';
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

  it('makes another account the default and removes one', async () => {
    const setDefault = vi.spyOn(api, 'accountsSetDefault').mockResolvedValue({ claude: 'cli', codex: 'cli' });
    const remove = vi.spyOn(api, 'accountsRemove').mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AccountsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Make CLI login (this computer) the default' }));
    await waitFor(() => expect(setDefault).toHaveBeenCalledWith('claude', 'cli'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Work' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('claude', 'w1'));
  });

  it('adding a Codex account makes the folder and opens a sign-in thread carrying its id', async () => {
    vi.spyOn(api, 'accountsAddCodex').mockResolvedValue({ id: 'n1', label: 'Second' });
    const create = vi.spyOn(api, 'createTerminal').mockResolvedValue({ id: 't-new' } as any);
    const open = vi.spyOn(useUI.getState(), 'requestOpenThread');
    render(<AccountsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add Codex account' }));
    fireEvent.change(screen.getByLabelText('Account name'), { target: { value: 'Second' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open the sign-in thread' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('P', { type: 'shell', label: 'Sign in — Codex (Second)', config: { signIn: 'codex', accountId: 'n1' } }));
    expect(open).toHaveBeenCalledWith({ sessionId: 'P', terminalId: 't-new' });
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
