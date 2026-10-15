import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ClaudeLogin, isClaudeAuthError } from './ClaudeLogin';
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
