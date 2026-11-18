import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApprovalCards } from './ApprovalCards';
import { api } from '../../../api/client';

vi.mock('../../../api/client', () => ({
  api: { getApprovals: vi.fn(), answerPermission: vi.fn(), resolveBlocked: vi.fn() },
}));

const blocked = { id: 'toolu_9', toolName: 'Bash', title: 'Wants to run a command', detail: 'git push --force', reason: '[Git Destructive]', at: 1 };

describe('ApprovalCards', () => {
  beforeEach(() => { vi.mocked(api.getApprovals).mockReset(); vi.mocked(api.answerPermission).mockReset(); vi.mocked(api.resolveBlocked).mockReset(); });

  it('a pending gated tool after a reload: read from the daemon; Allow once answers it', async () => {
    vi.mocked(api.getApprovals).mockResolvedValue({ mode: 'smart', blocked: [], pending: { requestId: 'r1', toolName: 'Bash', input: { command: 'chmod 777 x' } } });
    vi.mocked(api.answerPermission).mockResolvedValue(undefined);
    render(<ApprovalCards terminalId="t1" pending={null} refreshKey={0} />);
    expect(await screen.findByText('Wants to run a command')).toBeTruthy();
    fireEvent.click(screen.getByText('Details'));
    expect(screen.getByText('chmod 777 x')).toBeTruthy();
    fireEvent.click(screen.getByText('Allow once'));
    await waitFor(() => expect(api.answerPermission).toHaveBeenCalledWith('t1', { requestId: 'r1', decision: 'allow' }));
  });

  it('a question is not shown here (it has its own card)', async () => {
    vi.mocked(api.getApprovals).mockResolvedValue({ mode: 'smart', blocked: [], pending: null });
    const { container } = render(<ApprovalCards terminalId="t1" pending={{ requestId: 'q', toolName: 'AskUserQuestion', questions: [{ question: 'x' } as any] }} refreshKey={0} />);
    await waitFor(() => expect(api.getApprovals).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('a blocked action shows the reason; Keep blocked and Allow this resolve it', async () => {
    vi.mocked(api.getApprovals).mockResolvedValue({ mode: 'smart', blocked: [blocked, { ...blocked, id: 'b2' }], pending: null });
    vi.mocked(api.resolveBlocked).mockResolvedValue(undefined);
    render(<ApprovalCards terminalId="t1" pending={null} refreshKey={0} />);
    expect((await screen.findAllByText('Reason: [Git Destructive]')).length).toBe(2);
    fireEvent.click(screen.getAllByText('Allow this')[0]);
    await waitFor(() => expect(api.resolveBlocked).toHaveBeenCalledWith('t1', 'toolu_9', 'allow'));
    await waitFor(() => expect(screen.getAllByText('Keep blocked')).toHaveLength(1));
    fireEvent.click(screen.getByText('Keep blocked'));
    await waitFor(() => expect(api.resolveBlocked).toHaveBeenCalledWith('t1', 'b2', 'keep'));
  });
});
