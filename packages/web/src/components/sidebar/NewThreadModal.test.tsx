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

const start = () => fireEvent.click(screen.getByRole('button', { name: /start new thread/i }));
const lastInput = () => (api.createTerminal as any).mock.calls[0][1];

describe('NewThreadModal', () => {
  it('opens on Claude Code + CLI by default and creates a plain claude-code thread', async () => {
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);
    expect(screen.getByRole('button', { name: 'Claude Code' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'CLI mode' })).toHaveAttribute('aria-pressed', 'true');
    start();
    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
    const input = lastInput();
    expect(input.type).toBe('claude-code');
    // CLI + Default model + no auto-archive → no config at all.
    expect(input.config).toBeUndefined();
  });

  it('carries transport:structured when Pretty mode is chosen for Claude', async () => {
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pretty mode' }));
    start();
    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
    const input = lastInput();
    expect(input.type).toBe('claude-code');
    expect(input.config.transport).toBe('structured');
  });

  it('maps a Claude model chip to config.model (Opus → "opus")', async () => {
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Opus' }));
    start();
    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
    expect(lastInput().config.model).toBe('opus');
  });

  it('omits config.model when the Default chip stays selected', async () => {
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Opus' }));
    fireEvent.click(screen.getByRole('button', { name: 'Default' }));
    start();
    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
    expect(lastInput().config).toBeUndefined();
  });

  it('maps a Codex model chip to its real slug (5.6 Sol → "gpt-5.6-sol")', async () => {
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    fireEvent.click(screen.getByRole('button', { name: '5.6 Sol' }));
    start();
    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
    const input = lastInput();
    expect(input.type).toBe('codex');
    expect(input.config.model).toBe('gpt-5.6-sol');
  });

  it('posts the auto-archive policy alongside the transport when the whole row is toggled', async () => {
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pretty mode' }));
    // Whole-row toggle: clicking the title (not the switch itself) flips it.
    fireEvent.click(screen.getByText('Auto-archive thread'));
    start();
    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
    expect(lastInput().config).toEqual({ transport: 'structured', autoArchive: true, autoArchiveMs: 43_200_000 });
  });

  it('creates a plain shell for Terminal with no mode/model/resume', async () => {
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
    // Terminal is a peer card with no mode toggle, no model picker, no resume.
    expect(screen.queryByRole('button', { name: 'CLI mode' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Opus' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Resume recent')).not.toBeInTheDocument());
    start();
    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
    const input = lastInput();
    expect(input.type).toBe('shell');
    expect(input.config).toBeUndefined();
  });

  it('offers Codex Pretty (Phase C enabled) and carries transport:structured when chosen', async () => {
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    const pretty = screen.getByRole('button', { name: 'Pretty mode' });
    expect(pretty).not.toBeDisabled();
    expect(screen.queryByText('Coming soon')).not.toBeInTheDocument();
    fireEvent.click(pretty);
    start();
    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
    const input = lastInput();
    expect(input.type).toBe('codex');
    expect(input.config.transport).toBe('structured');
  });

  it('offers RESUME RECENT for Claude Code, fetched from recentCcSessions', async () => {
    (api.recentCcSessions as any).mockResolvedValue([
      { id: 'x1', preview: 'earlier chat', mtime: Date.now(), messageCount: 3, truncated: false },
    ]);
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);
    expect(await screen.findByText('earlier chat')).toBeInTheDocument();
    expect(api.recentCodexSessions).not.toHaveBeenCalled();
  });

  it('offers RESUME RECENT for Codex, fetched from recentCodexSessions', async () => {
    (api.recentCodexSessions as any).mockResolvedValue([
      { id: 'codex-1', preview: 'earlier codex session', mtime: Date.now(), messageCount: 5, truncated: false },
    ]);
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    // The codex preview text can only come from the codex endpoint's mock.
    expect(await screen.findByText('earlier codex session')).toBeInTheDocument();
    expect(api.recentCodexSessions).toHaveBeenCalledWith('s1');
  });

  it('creates a resumed codex thread with the chosen session id as externalId', async () => {
    (api.recentCodexSessions as any).mockResolvedValue([
      { id: 'codex-1', preview: 'earlier codex session', mtime: Date.now(), messageCount: 5, truncated: false },
    ]);
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    fireEvent.click(await screen.findByText('earlier codex session'));
    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
    const input = lastInput();
    expect(input.type).toBe('codex');
    expect(input.externalId).toBe('codex-1');
  });

  it('clears the stale resume list when switching harness, and refetches from the new endpoint', async () => {
    (api.recentCcSessions as any).mockResolvedValue([
      { id: 'x1', preview: 'earlier chat', mtime: Date.now(), messageCount: 3, truncated: false },
    ]);
    (api.recentCodexSessions as any).mockResolvedValue([
      { id: 'codex-1', preview: 'earlier codex session', mtime: Date.now(), messageCount: 5, truncated: false },
    ]);
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);
    expect(await screen.findByText('earlier chat')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    await waitFor(() => expect(screen.queryByText('earlier chat')).not.toBeInTheDocument());
    expect(await screen.findByText('earlier codex session')).toBeInTheDocument();
  });

  it('resets the model to Default when the harness changes', async () => {
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Opus' }));
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    // Codex's Default is selected; a stale 'opus' must not survive the switch.
    fireEvent.click(screen.getByRole('button', { name: 'Codex' })); // re-affirm codex
    start();
    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
    expect(lastInput().config).toBeUndefined();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<NewThreadModal sessionId="s1" onClose={onClose} onCreated={() => {}} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
