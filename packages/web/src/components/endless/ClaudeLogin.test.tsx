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
