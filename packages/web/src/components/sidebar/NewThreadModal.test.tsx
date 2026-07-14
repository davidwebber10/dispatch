import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NewThreadModal } from './NewThreadModal';
import { api } from '../../api/client';
import { useTabs } from '../../stores/tabs';

vi.mock('../../api/client', () => ({
  api: {
    createTerminal: vi.fn().mockResolvedValue({ id: 't-new' }),
    recentCcSessions: vi.fn().mockResolvedValue([]),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  useTabs.setState({ byProject: {}, loading: {} } as any);
  vi.spyOn(useTabs.getState(), 'loadTabs').mockResolvedValue(undefined as any);
});

describe('NewThreadModal', () => {
  it('creates a plain thread with no auto-archive config by default', async () => {
    render(<NewThreadModal sessionId="s1" initialKind="shell" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /start new thread/i }));

    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
    const [, input] = (api.createTerminal as any).mock.calls[0];
    expect(input.type).toBe('shell');
    expect(input.config?.autoArchive).toBeUndefined();
  });

  it('carries transport:structured for the structured Claude kind', async () => {
    render(<NewThreadModal sessionId="s1" initialKind="claude-structured" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /start new thread/i }));

    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
    const [, input] = (api.createTerminal as any).mock.calls[0];
    expect(input.type).toBe('claude-code');
    expect(input.config.transport).toBe('structured');
  });

  it('posts the auto-archive policy alongside the transport when toggled on', async () => {
    render(<NewThreadModal sessionId="s1" initialKind="claude-structured" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('switch', { name: /auto-archive thread/i }));
    fireEvent.click(screen.getByRole('button', { name: /start new thread/i }));

    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
    const [, input] = (api.createTerminal as any).mock.calls[0];
    expect(input.config).toEqual({ transport: 'structured', autoArchive: true, autoArchiveMs: 43_200_000 });
  });

  it('lets the type be changed before creating', async () => {
    render(<NewThreadModal sessionId="s1" initialKind="shell" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText('Thread type'), { target: { value: 'codex' } });
    fireEvent.click(screen.getByRole('button', { name: /start new thread/i }));

    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
    expect((api.createTerminal as any).mock.calls[0][1].type).toBe('codex');
  });

  it('offers RESUME RECENT only for the PTY Claude kind', async () => {
    (api.recentCcSessions as any).mockResolvedValue([
      { id: 'x1', preview: 'earlier chat', mtime: Date.now(), messageCount: 3, truncated: false },
    ]);
    render(<NewThreadModal sessionId="s1" initialKind="claude-code" onClose={() => {}} onCreated={() => {}} />);
    expect(await screen.findByText('earlier chat')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Thread type'), { target: { value: 'shell' } });
    await waitFor(() => expect(screen.queryByText('earlier chat')).not.toBeInTheDocument());
  });
});
