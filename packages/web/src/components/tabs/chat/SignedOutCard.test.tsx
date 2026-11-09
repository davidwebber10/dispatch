import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SignedOutCard } from './SignedOutCard';
import { api } from '../../../api/client';
import { useAccounts } from '../../../stores/accounts';
import { useTabs } from '../../../stores/tabs';
import { useUI } from '../../../stores/ui';
import { useThreadStatus } from '../../../stores/threadStatus';
import type { Terminal } from '../../../api/types';

vi.mock('../../../api/client', () => ({
  api: {
    getAccounts: vi.fn(),
    claudeLoginStart: vi.fn(),
    claudeLoginCode: vi.fn(),
    accountsClaudeLogin: vi.fn(),
    accountsCodexLogin: vi.fn(),
    accountsCodexLoginStatus: vi.fn(),
    accountsCodexLoginCancel: vi.fn(),
    createTerminal: vi.fn(),
    switchAccount: vi.fn(),
    listTerminals: vi.fn().mockResolvedValue([]),
  },
}));

const view = {
  claude: [{ id: 'cli', label: 'CLI login (this computer)', isCli: true, addedAt: null }, { id: 'work', label: 'Work', isCli: false, addedAt: '2026-11-06' }],
  codex: [{ id: 'cli', label: 'CLI login (this computer)', isCli: true, addedAt: null }, { id: 'cx2', label: 'Team', isCli: false, addedAt: '2026-11-06' }],
  defaults: { claude: 'cli', codex: 'cli' },
};
const tab = (over: Partial<Terminal> = {}): Terminal => ({ id: 't1', sessionId: 's1', type: 'claude-code', label: 'T', pid: 1, externalId: 'e1', workingDir: null, status: 'waiting', createdAt: '', config: { transport: 'structured', accountId: 'work' }, archivedAt: null, sortOrder: 0, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  (api.getAccounts as any).mockResolvedValue(view);
  useAccounts.setState({ view, loading: false } as any);
  useThreadStatus.setState({ byTerminal: {} } as any);
  useTabs.setState({ byProject: { s1: [tab()] } } as any);
  vi.spyOn(useTabs.getState(), 'loadTabs').mockResolvedValue(undefined as any);
});

describe('SignedOutCard', () => {
  it('names the signed-out account, with Sign in first and Switch account second', () => {
    render(<SignedOutCard tab={tab()} auth={{ provider: 'claude', accountId: 'work', reason: 'The login expired' }} onRetry={() => {}} />);
    expect(screen.getByText('Work is signed out')).toBeInTheDocument();
    expect(screen.getByText('The login expired')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    expect(buttons.slice(0, 2)).toEqual(['Sign in', 'Switch account']);
  });

  it('Claude added account: Sign in runs the headless setup-token flow for that account, then offers Retry', async () => {
    (api.accountsClaudeLogin as any).mockResolvedValue({ status: 'awaiting_code', url: 'https://claude.ai/oauth', error: null });
    (api.claudeLoginCode as any).mockResolvedValue({ status: 'complete', url: null, error: null });
    const onRetry = vi.fn();
    render(<SignedOutCard tab={tab()} auth={{ provider: 'claude', accountId: 'work', reason: 'The login expired' }} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(api.accountsClaudeLogin).toHaveBeenCalledWith('Work'));
    fireEvent.change(await screen.findByLabelText('Login code'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit code' }));
    const retry = await screen.findByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalled();
  });

  it('Claude CLI login: Sign in runs the daemon login (claude-auth)', async () => {
    (api.claudeLoginStart as any).mockResolvedValue({ status: 'awaiting_code', url: 'https://claude.ai/oauth', error: null });
    render(<SignedOutCard tab={tab({ config: { transport: 'structured' } })} auth={{ provider: 'claude', accountId: 'cli', reason: 'Not signed in' }} onRetry={() => {}} />);
    expect(screen.getByText('CLI login (this computer) is signed out')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(api.claudeLoginStart).toHaveBeenCalled());
    expect(api.accountsClaudeLogin).not.toHaveBeenCalled();
  });

  it('Codex added account: Sign in runs the device-code flow for it', async () => {
    (api.accountsCodexLogin as any).mockResolvedValue({ status: 'pending', url: 'https://auth.openai.com/codex/device', code: 'ABCD-1234', error: null });
    (api.accountsCodexLoginStatus as any).mockResolvedValue({ status: 'pending', url: 'https://auth.openai.com/codex/device', code: 'ABCD-1234', error: null });
    const t = tab({ type: 'codex', config: { transport: 'structured', accountId: 'cx2' } });
    render(<SignedOutCard tab={t} auth={{ provider: 'codex', accountId: 'cx2', reason: 'The login was refused' }} onRetry={() => {}} />);
    expect(screen.getByText('Team is signed out')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(api.accountsCodexLogin).toHaveBeenCalledWith('cx2'));
    expect(await screen.findByText('ABCD-1234')).toBeInTheDocument();
  });

  it('Codex CLI login: Sign in opens the CLI sign-in thread (the existing path) and keeps Retry at hand', async () => {
    (api.createTerminal as any).mockResolvedValue({ id: 'signin-1' });
    const openTab = vi.spyOn(useUI.getState(), 'requestOpenTab').mockImplementation(() => {});
    const t = tab({ type: 'codex', config: { transport: 'structured' } });
    render(<SignedOutCard tab={t} auth={{ provider: 'codex', accountId: 'cli', reason: 'Not signed in' }} onRetry={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(api.createTerminal).toHaveBeenCalledWith('s1', { type: 'shell', label: 'Sign in — Codex', config: { signIn: 'codex' } }));
    await waitFor(() => expect(openTab).toHaveBeenCalledWith('signin-1'));
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('Grok: no accounts, so no Switch account; Sign in opens the CLI sign-in thread', async () => {
    (api.createTerminal as any).mockResolvedValue({ id: 'signin-2' });
    render(<SignedOutCard tab={tab({ type: 'grok', config: {} })} auth={{ provider: 'grok', reason: 'Not signed in' }} onRetry={() => {}} />);
    expect(screen.getByText('Grok is signed out')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Switch account' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(api.createTerminal).toHaveBeenCalledWith('s1', { type: 'shell', label: 'Sign in — Grok', config: { signIn: 'grok' } }));
  });

  it('Switch account opens the existing AccountSwitchModal', async () => {
    render(<SignedOutCard tab={tab()} auth={{ provider: 'claude', accountId: 'work', reason: 'The login expired' }} onRetry={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch account' }));
    expect(await screen.findByRole('button', { name: 'Switch and restart' })).toBeInTheDocument();
  });

  it('after the thread moved to another account, it says so and offers Retry', () => {
    render(<SignedOutCard tab={tab({ config: { transport: 'structured', accountId: 'cli' } })} auth={{ provider: 'claude', accountId: 'work', reason: 'The login expired' }} onRetry={() => {}} />);
    expect(screen.getByText(/now runs on CLI login \(this computer\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
