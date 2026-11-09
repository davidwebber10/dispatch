import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { AccountsSection } from './AccountsSection';
import { codexLoginTiming } from './CodexLogin';
import { api } from '../../api/client';
import { useProjects } from '../../stores/projects';
import { useTabs } from '../../stores/tabs';
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

/** Opens an account's own page from its row (2026-11-07 redesign). */
const openAccount = async (name: string, provider: string, id: string) => {
  fireEvent.click(await screen.findByRole('button', { name }));
  return screen.findByTestId(`account-detail-${provider}-${id}`);
};

describe('<AccountsSection>', () => {
  it('lists every account as a row under its harness: email and plan on one line, Default as the value, the sign-in state', async () => {
    render(<AccountsSection />);
    expect(await screen.findByText('Work')).toBeInTheDocument();
    expect(screen.getByText(/me@work.com · Max/)).toBeInTheDocument();
    expect(screen.getByTestId('account-claude-w1')).toHaveTextContent('Default');
    expect(screen.getByTestId('account-claude-cli')).not.toHaveTextContent('Default');
    expect(screen.getByTestId('account-codex-p9')).toHaveTextContent('Not signed in');
    // No per-row action buttons: they live on the account's page.
    expect(screen.queryByRole('button', { name: 'Remove Work' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rename Work' })).toBeNull();
  });

  it('the CLI login has no Remove on its page', async () => {
    render(<AccountsSection />);
    const page = await openAccount('Claude: CLI login (this computer)', 'claude', 'cli');
    expect(within(page).queryByRole('button', { name: 'Remove account' })).toBeNull();
    expect(page).toHaveTextContent(/signed in on the daemon's computer/);
  });

  it('makes another account the default from its page', async () => {
    const setDefault = vi.spyOn(api, 'accountsSetDefault').mockResolvedValue({ claude: 'cli', codex: 'cli' });
    render(<AccountsSection />);
    const page = await openAccount('Claude: CLI login (this computer)', 'claude', 'cli');
    fireEvent.click(within(page).getByRole('button', { name: 'Make CLI login (this computer) the default' }));
    await waitFor(() => expect(setDefault).toHaveBeenCalledWith('claude', 'cli'));
  });

  it('removing an account from its page names the threads that revert to the default, then returns to the list', async () => {
    const remove = vi.spyOn(api, 'accountsRemove').mockResolvedValue({ unpinned: 2 });
    vi.spyOn(api, 'accountsThreads').mockResolvedValue([{ id: 't1', label: 'Fix login', sessionId: 'P' }, { id: 't2', label: 'Docs', sessionId: 'P' }]);
    render(<AccountsSection />);
    const page = await openAccount('Claude: Work', 'claude', 'w1');
    fireEvent.click(within(page).getByRole('button', { name: 'Remove account' }));
    const notice = await screen.findByText(/2 threads run on "Work": "Fix login", "Docs"\. They will use "CLI login \(this computer\)" the next time they start\./);
    expect(notice).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('claude', 'w1'));
    await waitFor(() => expect(screen.queryByTestId('account-detail-claude-w1')).toBeNull());
  });

  it('renames an account on its page (2026-11-06)', async () => {
    const rename = vi.spyOn(api, 'accountsRename').mockResolvedValue(view());
    render(<AccountsSection />);
    const page = await openAccount('Claude: Work', 'claude', 'w1');
    const input = within(page).getByLabelText('New name') as HTMLInputElement;
    expect(input.value).toBe('Work');
    fireEvent.change(input, { target: { value: 'Side' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(rename).toHaveBeenCalledWith('claude', 'w1', 'Side'));
  });

  it('the CLI login renames from an empty field (empty restores the stock name)', async () => {
    const rename = vi.spyOn(api, 'accountsRename').mockResolvedValue(view());
    render(<AccountsSection />);
    const page = await openAccount('Claude: CLI login (this computer)', 'claude', 'cli');
    const input = within(page).getByLabelText('New name') as HTMLInputElement;
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: 'Laptop' } });
    fireEvent.click(within(page).getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(rename).toHaveBeenCalledWith('claude', 'cli', 'Laptop'));
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

  it('a Codex account with no login offers Sign in again on its page, which starts the device sign-in for it', async () => {
    const login = vi.spyOn(api, 'accountsCodexLogin').mockResolvedValue({ accountId: 'p9', status: 'awaiting_user', url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345', error: null, createdAt: 'x' });
    vi.spyOn(api, 'accountsCodexLoginStatus').mockResolvedValue({ accountId: 'p9', status: 'awaiting_user', url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345', error: null, createdAt: 'x' });
    render(<AccountsSection />);
    const page = await openAccount('Codex: Personal', 'codex', 'p9');
    fireEvent.click(within(page).getByRole('button', { name: 'Sign in again to Personal' }));
    await waitFor(() => expect(login).toHaveBeenCalledWith('p9'));
    expect(await screen.findByText('ABCD-12345')).toBeInTheDocument();
  });

  it('only an account with no login gets Sign in again: not the CLI login', async () => {
    render(<AccountsSection />);
    const page = await openAccount('Codex: CLI login (this computer)', 'codex', 'cli');
    expect(within(page).queryByRole('button', { name: /Sign in again/ })).toBeNull();
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

// W1-H (2026-11-09): what each Claude sign-in can do for the usage figures, and the next step.
describe('<AccountsSection> usage access (W1-H)', () => {
  const withAccess = (id: string, usageAccess: { state: 'ok' | 'sign-in-needed' | 'not-available' | 'rate-limited'; lastOkAt: number | null }): AccountsView => {
    const v = view();
    v.claude = v.claude.map((a) => (a.id === id ? { ...a, usageAccess } : a));
    return v;
  };

  it('an account with sign-in-needed shows the Sign in again button and it starts the login for that account id', async () => {
    vi.spyOn(api, 'getAccounts').mockResolvedValue(withAccess('w1', { state: 'sign-in-needed', lastOkAt: null }));
    const login = vi.spyOn(api, 'accountsClaudeLogin').mockResolvedValue({ status: 'awaiting_code', url: 'https://claude.ai/oauth/x', error: null } as never);
    render(<AccountsSection />);
    // The list says it on the row.
    expect(await screen.findByTestId('account-claude-w1')).toHaveTextContent('Sign in again');
    const page = await openAccount('Claude: Work', 'claude', 'w1');
    expect(page).toHaveTextContent('Sign in again to see usage for this account');
    fireEvent.click(within(page).getByRole('button', { name: 'Sign in again to Work' }));
    await waitFor(() => expect(login).toHaveBeenCalledWith('Work', 'w1'));
    // The existing Claude login flow: the link to open and the code to paste.
    expect(await within(page).findByText(/Open the Claude login page/)).toBeInTheDocument();
  });

  it('the CLI login with sign-in-needed names the computer to sign in on, and has no button', async () => {
    vi.spyOn(api, 'getAccounts').mockResolvedValue(withAccess('cli', { state: 'sign-in-needed', lastOkAt: null }));
    render(<AccountsSection />);
    const page = await openAccount('Claude: CLI login (this computer)', 'claude', 'cli');
    expect(page).toHaveTextContent(/Sign in again on the daemon's computer/);
    expect(within(page).queryByRole('button', { name: /^Sign in again/ })).toBeNull();
  });

  it('an account with not-available shows the note and no error style', async () => {
    vi.spyOn(api, 'getAccounts').mockResolvedValue(withAccess('w1', { state: 'not-available', lastOkAt: null }));
    render(<AccountsSection />);
    const row = await screen.findByTestId('account-claude-w1');
    expect(row).not.toHaveTextContent('Sign in again');
    expect(within(row).queryByTestId('status-mark')).toBeNull(); // no warning mark on the row
    const page = await openAccount('Claude: Work', 'claude', 'w1');
    const note = within(page).getByTestId('usage-access-note');
    expect(note).toHaveTextContent('This sign-in can run threads. It cannot read usage figures.');
    expect(note.outerHTML).not.toMatch(/status-red|status-yellow/);
    expect(within(page).queryByRole('alert')).toBeNull();
    expect(within(page).queryByRole('button', { name: /^Sign in again/ })).toBeNull();
  });

  it('a rate-limited account says when usage was last read, and Check again asks the daemon', async () => {
    vi.spyOn(api, 'getAccounts').mockResolvedValue(withAccess('w1', { state: 'rate-limited', lastOkAt: Date.now() - 12 * 60_000 }));
    const check = vi.spyOn(api, 'accountsCheckUsage').mockResolvedValue({ ok: true });
    render(<AccountsSection />);
    const page = await openAccount('Claude: Work', 'claude', 'w1');
    expect(within(page).getByTestId('usage-access-note')).toHaveTextContent('Updated 12 min ago');
    fireEvent.click(within(page).getByRole('button', { name: 'Check usage again for Work' }));
    await waitFor(() => expect(check).toHaveBeenCalledWith('w1'));
  });

  it('an account whose usage reads work shows no usage note', async () => {
    vi.spyOn(api, 'getAccounts').mockResolvedValue(withAccess('w1', { state: 'ok', lastOkAt: Date.now() }));
    render(<AccountsSection />);
    const page = await openAccount('Claude: Work', 'claude', 'w1');
    expect(within(page).queryByTestId('usage-access-note')).toBeNull();
  });
});
