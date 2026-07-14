import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NewThreadModal } from './NewThreadModal';
import { api } from '../../api/client';
import { useTabs } from '../../stores/tabs';

vi.mock('../../api/client', () => ({
  api: {
    createTerminal: vi.fn().mockResolvedValue({ id: 't-new' }),
    recentCcSessions: vi.fn().mockResolvedValue([]),
    recentCodexSessions: vi.fn().mockResolvedValue([]),
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

  it('offers RESUME RECENT for the PTY Claude kind, fetched from recentCcSessions', async () => {
    (api.recentCcSessions as any).mockResolvedValue([
      { id: 'x1', preview: 'earlier chat', mtime: Date.now(), messageCount: 3, truncated: false },
    ]);
    render(<NewThreadModal sessionId="s1" initialKind="claude-code" onClose={() => {}} onCreated={() => {}} />);
    expect(await screen.findByText('earlier chat')).toBeInTheDocument();
    expect(api.recentCodexSessions).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Thread type'), { target: { value: 'shell' } });
    await waitFor(() => expect(screen.queryByText('earlier chat')).not.toBeInTheDocument());
  });

  it('offers RESUME RECENT for the codex kind, fetched from recentCodexSessions (not recentCcSessions)', async () => {
    (api.recentCodexSessions as any).mockResolvedValue([
      { id: 'codex-1', preview: 'earlier codex session', mtime: Date.now(), messageCount: 5, truncated: false },
    ]);
    render(<NewThreadModal sessionId="s1" initialKind="codex" onClose={() => {}} onCreated={() => {}} />);
    expect(await screen.findByText('earlier codex session')).toBeInTheDocument();
    expect(api.recentCcSessions).not.toHaveBeenCalled();
  });

  it('creates a resumed codex thread with the chosen session id as externalId', async () => {
    (api.recentCodexSessions as any).mockResolvedValue([
      { id: 'codex-1', preview: 'earlier codex session', mtime: Date.now(), messageCount: 5, truncated: false },
    ]);
    render(<NewThreadModal sessionId="s1" initialKind="codex" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(await screen.findByText('earlier codex session'));

    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
    const [, input] = (api.createTerminal as any).mock.calls[0];
    expect(input.type).toBe('codex');
    expect(input.externalId).toBe('codex-1');
  });

  it('clears the stale list when switching kinds, and refetches from the new endpoint', async () => {
    (api.recentCcSessions as any).mockResolvedValue([
      { id: 'x1', preview: 'earlier chat', mtime: Date.now(), messageCount: 3, truncated: false },
    ]);
    (api.recentCodexSessions as any).mockResolvedValue([
      { id: 'codex-1', preview: 'earlier codex session', mtime: Date.now(), messageCount: 5, truncated: false },
    ]);
    render(<NewThreadModal sessionId="s1" initialKind="claude-code" onClose={() => {}} onCreated={() => {}} />);
    expect(await screen.findByText('earlier chat')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Thread type'), { target: { value: 'codex' } });
    await waitFor(() => expect(screen.queryByText('earlier chat')).not.toBeInTheDocument());
    expect(await screen.findByText('earlier codex session')).toBeInTheDocument();
  });

  it('shows no resume list for claude-structured or shell', async () => {
    const { unmount } = render(<NewThreadModal sessionId="s1" initialKind="claude-structured" onClose={() => {}} onCreated={() => {}} />);
    await waitFor(() => expect(screen.queryByText('RESUME RECENT')).not.toBeInTheDocument());
    expect(api.recentCcSessions).not.toHaveBeenCalled();
    expect(api.recentCodexSessions).not.toHaveBeenCalled();
    unmount();

    render(<NewThreadModal sessionId="s1" initialKind="shell" onClose={() => {}} onCreated={() => {}} />);
    await waitFor(() => expect(screen.queryByText('RESUME RECENT')).not.toBeInTheDocument());
    expect(api.recentCcSessions).not.toHaveBeenCalled();
    expect(api.recentCodexSessions).not.toHaveBeenCalled();
  });
});
