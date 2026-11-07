import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CodexLogin, codexLoginTiming } from './CodexLogin';
import { api } from '../../api/client';
import type { CodexLoginSession } from '../../api/types';

const waiting: CodexLoginSession = { accountId: 'a1', status: 'awaiting_user', url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345', error: null, createdAt: 'x' };

beforeEach(() => { codexLoginTiming.pollMs = 10; });
afterEach(() => { vi.restoreAllMocks(); codexLoginTiming.pollMs = 2000; });

/** The device-code sign-in for a Codex account (2026-11-07): works from a phone, nothing to paste back. */
describe('<CodexLogin>', () => {
  it('starts the sign-in, shows the link and the one-time code, and finishes when the daemon says complete', async () => {
    const start = vi.spyOn(api, 'accountsCodexLogin').mockResolvedValue(waiting);
    const status = vi.spyOn(api, 'accountsCodexLoginStatus').mockResolvedValueOnce(waiting).mockResolvedValue({ ...waiting, status: 'complete', url: null, code: null });
    const onDone = vi.fn();
    render(<CodexLogin accountId="a1" onDone={onDone} />);
    await waitFor(() => expect(start).toHaveBeenCalledWith('a1'));
    expect(await screen.findByText('ABCD-12345')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open the Codex sign-in page/ })).toHaveAttribute('href', 'https://auth.openai.com/codex/device');
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(status).toHaveBeenCalledWith('a1');
  });

  it('shows why it failed and offers Try again, which starts a new attempt', async () => {
    const start = vi.spyOn(api, 'accountsCodexLogin')
      .mockResolvedValueOnce(waiting)
      .mockResolvedValueOnce({ ...waiting, code: 'WXYZ-99999' });
    vi.spyOn(api, 'accountsCodexLoginStatus')
      .mockResolvedValueOnce({ ...waiting, status: 'error', url: null, code: null, error: 'Codex said: device code expired' })
      .mockResolvedValue({ ...waiting, code: 'WXYZ-99999' });
    render(<CodexLogin accountId="a1" onDone={() => {}} />);
    expect(await screen.findByText(/device code expired/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('WXYZ-99999')).toBeInTheDocument();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('a failed start shows the error and Try again', async () => {
    vi.spyOn(api, 'accountsCodexLogin').mockRejectedValueOnce(new Error('codex is not installed')).mockResolvedValue(waiting);
    vi.spyOn(api, 'accountsCodexLoginStatus').mockResolvedValue(waiting);
    render(<CodexLogin accountId="a1" onDone={() => {}} />);
    expect(await screen.findByText(/codex is not installed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('ABCD-12345')).toBeInTheDocument();
  });

  it('Cancel abandons the attempt on the daemon', async () => {
    vi.spyOn(api, 'accountsCodexLogin').mockResolvedValue(waiting);
    vi.spyOn(api, 'accountsCodexLoginStatus').mockResolvedValue(waiting);
    const cancel = vi.spyOn(api, 'accountsCodexLoginCancel').mockResolvedValue(undefined as any);
    const onCancel = vi.fn();
    render(<CodexLogin accountId="a1" onDone={() => {}} onCancel={onCancel} />);
    await screen.findByText('ABCD-12345');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('a1'));
    expect(onCancel).toHaveBeenCalled();
  });
});
