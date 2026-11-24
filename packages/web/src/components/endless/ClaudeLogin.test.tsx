import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ClaudeLogin, isClaudeAuthError, plainLoginError } from './ClaudeLogin';
import { api } from '../../api/client';
import type { ClaudeLoginSession } from '../../api/types';

const session = (over: Partial<ClaudeLoginSession> = {}): ClaudeLoginSession => ({ id: 's1', status: 'awaiting_code', url: 'https://claude.com/cai/oauth/authorize?x=1', error: null, createdAt: '', ...over });

beforeEach(() => { vi.restoreAllMocks(); });

describe('isClaudeAuthError', () => {
  it.each([
    ['Failed to authenticate: OAuth session expired and could not be refreshed', true],
    ['Invalid API key · Please run /login', true],
    ['401 Unauthorized', true],
    ['Not logged in · Please run /login', true],
    ['the turn process exited (code 1) before it finished', false],
    ["You've hit your session limit", false],
  ])('%s → %s', (text, want) => { expect(isClaudeAuthError(text)).toBe(want); });
});

// Spec 2026-11-23 (one source for the Claude login), section 3: the generic card.
describe('ClaudeLogin: a sign-in that makes a Dispatch login', () => {
  const made = { id: 'a1', label: 'Dispatch login, Nov 23', isDefault: false };
  const start = () => vi.spyOn(api, 'claudeLoginStart').mockResolvedValue(session({ landsIn: { kind: 'new', label: made.label } }));
  const signIn = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Log in to Claude' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Login code' }), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit code' }));
  };

  it('says before the code is pasted what the two ways are', async () => {
    start();
    render(<ClaudeLogin onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Log in to Claude' }));
    const note = await screen.findByTestId('claude-login-two-ways');
    expect(note).toHaveTextContent('Run claude in a terminal and sign in there to keep your claude.ai connectors');
    expect(note).toHaveTextContent('Or sign in here. This makes a Dispatch login, which has no claude.ai connectors');
  });

  it('asks before the default changes; Make default sets it and then finishes', async () => {
    start();
    vi.spyOn(api, 'claudeLoginCode').mockResolvedValue(session({ status: 'complete', url: null, account: made }));
    const setDefault = vi.spyOn(api, 'accountsSetDefault').mockResolvedValue({ claude: 'a1', codex: 'cli' });
    const onDone = vi.fn();
    render(<ClaudeLogin onDone={onDone} />);
    await signIn();
    expect(await screen.findByText(/Use this login for new threads and Chat\?/)).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(setDefault).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Make default' }));
    await waitFor(() => expect(setDefault).toHaveBeenCalledWith('claude', 'a1'));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it('Not now finishes and leaves the default as it is', async () => {
    start();
    vi.spyOn(api, 'claudeLoginCode').mockResolvedValue(session({ status: 'complete', url: null, account: made }));
    const setDefault = vi.spyOn(api, 'accountsSetDefault');
    const onDone = vi.fn();
    render(<ClaudeLogin onDone={onDone} />);
    await signIn();
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(setDefault).not.toHaveBeenCalled();
  });

  it('a sign-in that lands in the default account, or one started for a named account, asks nothing', async () => {
    vi.spyOn(api, 'claudeLoginStart').mockResolvedValue(session({ landsIn: { kind: 'existing', label: 'Team' } }));
    vi.spyOn(api, 'claudeLoginCode').mockResolvedValue(session({ status: 'complete', url: null, account: { id: 't1', label: 'Team', isDefault: true } }));
    const onDone = vi.fn();
    const { unmount } = render(<ClaudeLogin onDone={onDone} />);
    await signIn();
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('claude-login-two-ways')).toBeNull();
    unmount();
    // The Accounts page adds an account on purpose: the new one is not the default, and no question follows.
    vi.spyOn(api, 'claudeLoginCode').mockResolvedValue(session({ status: 'complete', url: null, account: made }));
    const named = vi.fn();
    render(<ClaudeLogin onDone={named} start={async () => session()} />);
    await signIn();
    await waitFor(() => expect(named).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Make default' })).toBeNull();
  });
});

describe('ClaudeLogin', () => {
  it('starts a login, links the Claude page, sends the pasted code, and calls onDone when complete', async () => {
    const start = vi.spyOn(api, 'claudeLoginStart').mockResolvedValue(session());
    const code = vi.spyOn(api, 'claudeLoginCode').mockResolvedValue(session({ status: 'complete', url: null }));
    const onDone = vi.fn();
    render(<ClaudeLogin onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'Log in to Claude' }));
    const link = await screen.findByRole('link', { name: /Open the Claude login page/ });
    expect(start).toHaveBeenCalledTimes(1);
    expect(link).toHaveAttribute('href', 'https://claude.com/cai/oauth/authorize?x=1');
    expect(link).toHaveAttribute('target', '_blank');
    fireEvent.change(screen.getByRole('textbox', { name: 'Login code' }), { target: { value: '  abc#123  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit code' }));
    await waitFor(() => expect(code).toHaveBeenCalledWith('abc#123'));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it('a rejected code shows the error and keeps the code box', async () => {
    vi.spyOn(api, 'claudeLoginStart').mockResolvedValue(session());
    vi.spyOn(api, 'claudeLoginCode').mockResolvedValue(session({ error: 'That code did not work. Copy it again.' }));
    const onDone = vi.fn();
    render(<ClaudeLogin onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'Log in to Claude' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Login code' }), { target: { value: 'bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit code' }));
    expect(await screen.findByText('That code did not work. Copy it again.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Login code' })).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('a rejected code swaps in the new sign-in link and empties the code box', async () => {
    // The CLI starts a fresh sign-in after a rejection; a code from the old link cannot work.
    vi.spyOn(api, 'claudeLoginStart').mockResolvedValue(session());
    vi.spyOn(api, 'claudeLoginCode').mockResolvedValue(session({ url: 'https://claude.com/cai/oauth/authorize?x=2', error: "OAuth error: That code wasn't accepted." }));
    render(<ClaudeLogin onDone={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Log in to Claude' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Login code' }), { target: { value: 'old#code' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit code' }));
    expect(await screen.findByText(/OAuth error: That code wasn't accepted/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open the Claude login page/ })).toHaveAttribute('href', 'https://claude.com/cai/oauth/authorize?x=2');
    expect(screen.getByRole('textbox', { name: 'Login code' })).toHaveValue('');
  });

  it('a failed start shows the error and lets the user try again', async () => {
    vi.spyOn(api, 'claudeLoginStart').mockRejectedValueOnce(new Error('POST /api/claude-auth/login failed: 500 claude not found'));
    render(<ClaudeLogin onDone={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Log in to Claude' }));
    expect(await screen.findByText(/claude not found/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log in to Claude' })).toBeEnabled();
  });
});

describe('ClaudeLogin notices how the login ended', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  const open = async () => {
    vi.spyOn(api, 'claudeLoginStart').mockResolvedValue(session());
    const onDone = vi.fn();
    render(<ClaudeLogin onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'Log in to Claude' }));
    await screen.findByRole('textbox', { name: 'Login code' });
    return onDone;
  };
  const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(2100); });

  it('finishes by itself when the daemon reports the login complete', async () => {
    const status = vi.spyOn(api, 'claudeAuthStatus').mockResolvedValue({ authenticated: true, session: session({ status: 'complete', url: null }) });
    const onDone = await open();
    await tick();
    expect(status).toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('keeps the code box while the login still waits for a code', async () => {
    vi.spyOn(api, 'claudeAuthStatus').mockResolvedValue({ authenticated: false, session: session() });
    const onDone = await open();
    await tick();
    expect(screen.getByRole('textbox', { name: 'Login code' })).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('takes a new link from the daemon while it waits (the CLI printed it late after a refused code)', async () => {
    vi.spyOn(api, 'claudeAuthStatus').mockResolvedValue({ authenticated: false, session: session({ url: 'https://claude.com/cai/oauth/authorize?x=9' }) });
    await open();
    fireEvent.change(screen.getByRole('textbox', { name: 'Login code' }), { target: { value: 'dead#code' } });
    await tick();
    expect(screen.getByRole('link', { name: /Open the Claude login page/ })).toHaveAttribute('href', 'https://claude.com/cai/oauth/authorize?x=9');
    expect(screen.getByRole('textbox', { name: 'Login code' })).toHaveValue(''); // the code of the dead link is gone
  });

  it('says so and offers a new start when the login has ended', async () => {
    vi.spyOn(api, 'claudeAuthStatus').mockResolvedValue({ authenticated: false, session: null });
    const onDone = await open();
    await tick();
    expect(await screen.findByText(/This login ended/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log in to Claude' })).toBeEnabled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('keeps the code box when the status check fails', async () => {
    vi.spyOn(api, 'claudeAuthStatus').mockRejectedValue(new Error('network'));
    await open();
    await tick();
    expect(screen.getByRole('textbox', { name: 'Login code' })).toBeInTheDocument();
  });

  it('treats a session with another id as an ended login', async () => {
    vi.spyOn(api, 'claudeAuthStatus').mockResolvedValue({ authenticated: false, session: session({ id: 'other' }) });
    const onDone = await open();
    await tick();
    expect(await screen.findByText(/This login ended/)).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('calls onDone one time when two status checks overlap', async () => {
    const answers: Array<(v: { authenticated: boolean; session: ClaudeLoginSession | null }) => void> = [];
    vi.spyOn(api, 'claudeAuthStatus').mockImplementation(() => new Promise((r) => { answers.push(r); }));
    const onDone = await open();
    await tick();
    await tick();
    expect(answers.length).toBeGreaterThanOrEqual(2);
    await act(async () => { for (const a of answers) a({ authenticated: true, session: session({ status: 'complete', url: null }) }); });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('stops the status checks while a code is being sent', async () => {
    const status = vi.spyOn(api, 'claudeAuthStatus').mockResolvedValue({ authenticated: false, session: session() });
    vi.spyOn(api, 'claudeLoginCode').mockImplementation(() => new Promise(() => {}));
    await open();
    fireEvent.change(screen.getByRole('textbox', { name: 'Login code' }), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit code' }));
    await tick();
    status.mockClear();
    await tick();
    expect(status).not.toHaveBeenCalled();
  });

  it('finishes when the code arrived after the login had already completed', async () => {
    vi.spyOn(api, 'claudeAuthStatus').mockResolvedValue({ authenticated: true, session: session({ status: 'complete', url: null }) });
    vi.spyOn(api, 'claudeLoginCode').mockRejectedValue(new Error('no login in progress'));
    const onDone = await open();
    fireEvent.change(screen.getByRole('textbox', { name: 'Login code' }), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit code' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/no login in progress/)).not.toBeInTheDocument();
  });
});

describe('the person reads plain words, never the API call', () => {
  it('plainLoginError keeps the daemon\'s reason and drops the request line', () => {
    expect(plainLoginError(new Error("POST /api/claude-auth/login/code failed: 400 — Claude did not accept that code. Start the sign-in again and use the new code.")))
      .toBe('Claude did not accept that code. Start the sign-in again and use the new code.');
    expect(plainLoginError(new Error('POST /api/claude-auth/login/code failed: 400 — no login in progress'))).toBe('This sign-in ended. Start it again.');
    expect(plainLoginError(new Error('POST /api/claude-auth/login/code: Reconnecting…'))).toBe('This sign-in ended. Start it again.');
  });

  it('a code Claude refused shows Claude\'s reason without "POST" or a status code', async () => {
    vi.spyOn(api, 'claudeLoginStart').mockResolvedValue(session());
    vi.spyOn(api, 'claudeLoginCode').mockRejectedValue(new Error('POST /api/claude-auth/login/code failed: 400 — The sign-in did not finish. Claude said: network error. Start it again.'));
    vi.spyOn(api, 'claudeAuthStatus').mockResolvedValue({ authenticated: false, session: session({ status: 'error', url: null }) });
    render(<ClaudeLogin onDone={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Log in to Claude' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Login code' }), { target: { value: 'a#b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit code' }));
    const shown = await screen.findByText(/Claude said: network error/);
    expect(shown.textContent).not.toMatch(/POST|400|\/api\//);
  });

  it('a sign-in that ended by itself (a timeout) says why', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.spyOn(api, 'claudeLoginStart').mockResolvedValue(session());
      vi.spyOn(api, 'claudeAuthStatus').mockResolvedValue({ authenticated: false, session: session({ status: 'error', url: null, error: 'The sign-in took too long and was stopped. Start it again.' }) });
      render(<ClaudeLogin onDone={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: 'Log in to Claude' }));
      await screen.findByRole('textbox', { name: 'Login code' });
      await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
      expect(await screen.findByText(/took too long/)).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });
});
