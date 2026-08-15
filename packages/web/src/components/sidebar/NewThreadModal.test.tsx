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
    recheckProviders: vi.fn().mockResolvedValue([
      { name: 'claude', installed: true, signedIn: true },
      { name: 'codex', installed: true, signedIn: true },
      { name: 'grok', installed: true, signedIn: true },
    ]),
    installProvider: vi.fn(),
  },
}));

/** Model moved from chips to a <select>; this picks by visible option label. */
const pickModel = (label: string) => {
  const sel = screen.getByLabelText('Model') as HTMLSelectElement;
  const opt = Array.from(sel.options).find((o) => o.text === label);
  if (!opt) throw new Error(`no model option "${label}"`);
  fireEvent.change(sel, { target: { value: opt.value } });
};

/** Auto-archive now lives behind the Advanced disclosure. */
const openAdvanced = () => fireEvent.click(screen.getByRole('button', { name: /advanced/i }));

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
    pickModel('Opus');
    start();
    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
    expect(lastInput().config.model).toBe('opus');
  });

  it('omits config.model when the Default option stays selected', async () => {
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);
    pickModel('Opus');
    pickModel('Default');
    start();
    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
    expect(lastInput().config).toBeUndefined();
  });

  it('maps a Codex model option to its real slug (5.6 Sol → "gpt-5.6-sol")', async () => {
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    pickModel('5.6 Sol');
    start();
    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
    const input = lastInput();
    expect(input.type).toBe('codex');
    expect(input.config.model).toBe('gpt-5.6-sol');
  });

  it('posts the auto-archive policy alongside the transport when the whole row is toggled', async () => {
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pretty mode' }));
    openAdvanced();
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
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument();
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
    pickModel('Opus');
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

describe('NewThreadModal — Grok', () => {
  it('offers Grok as a fourth harness and creates a grok thread', async () => {
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Grok' }));
    start();
    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
    expect(lastInput().type).toBe('grok');
  });

  it('Grok is Pretty-only: CLI is disabled and Pretty reads as active without a pick', async () => {
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Grok' }));
    expect(screen.getByRole('button', { name: 'CLI mode' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pretty mode' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Pretty mode' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('sends transport:structured for a Grok thread WITHOUT the user picking a mode', async () => {
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Grok' }));
    start();
    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
    expect(lastInput().config.transport).toBe('structured');
  });

  it('maps the Grok model option to its real id', async () => {
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Grok' }));
    pickModel('Grok 4.5');
    start();
    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
    expect(lastInput().config.model).toBe('grok-4.5');
  });

  it('offers no resume list for Grok — no session id is captured yet', async () => {
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Grok' }));
    await waitFor(() => expect(screen.queryByText('Resume recent')).not.toBeInTheDocument());
  });
});

describe('NewThreadModal — uninstalled CLIs', () => {
  const notInstalled = (name: string) => ({
    name, installed: false, signedIn: false,
  });

  it('marks a missing CLI Install on its card, but still lets you select it', async () => {
    (api.recheckProviders as any).mockResolvedValue([
      { name: 'claude', installed: true, signedIn: true },
      { name: 'codex', installed: true, signedIn: true },
      notInstalled('grok'),
    ]);
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);

    const grok = await screen.findByRole('button', { name: 'Grok Install' });
    await waitFor(() => expect(grok).toHaveTextContent('Install'));
    expect(grok).not.toBeDisabled();
    fireEvent.click(grok);
    expect(grok).toHaveAttribute('aria-pressed', 'true');
  });

  it('replaces the options with the install prompt when you select a missing CLI', async () => {
    (api.recheckProviders as any).mockResolvedValue([
      { name: 'claude', installed: true, signedIn: true },
      { name: 'codex', installed: true, signedIn: true },
      notInstalled('grok'),
    ]);
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Grok Install' }));

    expect(await screen.findByText(/Grok isn't installed/)).toBeInTheDocument();
    // No point offering any of these for something that cannot run.
    expect(screen.queryByRole('button', { name: /start new thread/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'CLI mode' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /advanced/i })).not.toBeInTheDocument();
    // The command is shown so you can run it yourself instead.
    expect(screen.getByText('curl -fsSL https://x.ai/cli/install.sh | bash')).toBeInTheDocument();
  });

  it('shows the normal options again as soon as you pick an installed harness', async () => {
    (api.recheckProviders as any).mockResolvedValue([
      { name: 'claude', installed: true, signedIn: true },
      { name: 'codex', installed: true, signedIn: true },
      notInstalled('grok'),
    ]);
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Grok Install' }));
    expect(await screen.findByText(/Grok isn't installed/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    expect(screen.queryByText(/isn't installed/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start new thread/i })).toBeInTheDocument();
  });

  it('applies the same rule to Claude Code and Codex, not just Grok', async () => {
    (api.recheckProviders as any).mockResolvedValue([
      notInstalled('claude'), notInstalled('codex'),
      { name: 'grok', installed: true, signedIn: true },
    ]);
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Claude Code Install' })).toHaveTextContent('Install'));
    expect(screen.getByRole('button', { name: 'Codex Install' })).toHaveTextContent('Install');
    // Terminal has no CLI behind it, so it is never marked.
    expect(screen.getByRole('button', { name: 'Terminal' })).not.toHaveTextContent('Install');
    // Claude is selected by default and missing, so the prompt names Claude Code.
    expect(await screen.findByText(/Claude Code isn't installed/)).toBeInTheDocument();
  });

  it('marks nothing while the probe is still in flight', () => {
    (api.recheckProviders as any).mockReturnValue(new Promise(() => {}));
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);
    expect(screen.getByRole('button', { name: 'Grok' })).not.toHaveTextContent('Install');
    expect(screen.getByRole('button', { name: /start new thread/i })).toBeInTheDocument();
  });

  it('installs a missing CLI in place, then restores the options', async () => {
    (api.recheckProviders as any).mockResolvedValue([
      { name: 'claude', installed: true, signedIn: true },
      { name: 'codex', installed: true, signedIn: true },
      notInstalled('grok'),
    ]);
    (api.installProvider as any).mockResolvedValue({
      ok: true, output: 'Grok 1.0.3 installed',
      status: { name: 'grok', installed: true, signedIn: false },
      loginCommand: 'grok login',
    });
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Grok Install' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Install Grok' }));
    await waitFor(() => expect(api.installProvider).toHaveBeenCalledWith('grok'));
    // Installing never signs you in, so the install step hands straight over to sign-in
    // rather than to options for a thread that would stop at a login screen.
    await waitFor(() => expect(screen.getByText(/Grok isn't signed in/)).toBeInTheDocument());
    expect(screen.queryByText(/isn't installed/)).not.toBeInTheDocument();
  });

  it('surfaces an install failure instead of silently doing nothing', async () => {
    (api.recheckProviders as any).mockResolvedValue([
      { name: 'claude', installed: true, signedIn: true },
      { name: 'codex', installed: true, signedIn: true },
      notInstalled('grok'),
    ]);
    (api.installProvider as any).mockResolvedValue({
      ok: false, output: 'curl: (6) Could not resolve host: x.ai',
      status: { name: 'grok', installed: false, signedIn: false },
      loginCommand: 'grok login',
    });
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Grok Install' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Install Grok' }));
    expect(await screen.findByText(/Could not resolve host/)).toBeInTheDocument();
    // Still not installed, so the prompt stays put.
    expect(screen.getByText(/Grok isn't installed/)).toBeInTheDocument();
  });

  it('offers to sign you in when the CLI is installed but signed out', async () => {
    (api.recheckProviders as any).mockResolvedValue([
      { name: 'claude', installed: true, signedIn: true },
      { name: 'codex', installed: true, signedIn: true },
      { name: 'grok', installed: true, signedIn: false },
    ]);
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Grok' }));
    expect(await screen.findByText(/Grok isn't signed in/)).toBeInTheDocument();
    // The plain login command, not the bare TUI that dead-ends on a phone.
    expect(screen.getByText('grok login')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start new thread/i })).not.toBeInTheDocument();
  });

  it('opens a sign-in thread that runs the login command', async () => {
    (api.recheckProviders as any).mockResolvedValue([
      { name: 'claude', installed: true, signedIn: true },
      { name: 'codex', installed: true, signedIn: true },
      { name: 'grok', installed: true, signedIn: false },
    ]);
    const onCreated = vi.fn();
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={onCreated} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Grok' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to Grok' }));

    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
    const input = lastInput();
    expect(input.type).toBe('shell');
    expect(input.label).toBe('Sign in — Grok');
    // config.signIn both makes the daemon run `grok login` directly and marks the one
    // thread whose output Dispatch reads for a sign-in URL.
    expect(input.config).toEqual({ signIn: 'grok' });
    expect(onCreated).toHaveBeenCalled();
  });

  it('treats an unknown sign-in state as fine, not as signed out', async () => {
    // 'unknown' means the credential may live somewhere we cannot see. Blocking on it would
    // wrongly stop Claude and Codex threads from starting at all.
    (api.recheckProviders as any).mockResolvedValue([
      { name: 'claude', installed: true, signedIn: 'unknown' },
      { name: 'codex', installed: true, signedIn: true },
      { name: 'grok', installed: true, signedIn: true },
    ]);
    render(<NewThreadModal sessionId="s1" onClose={() => {}} onCreated={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /start new thread/i })).toBeInTheDocument());
    expect(screen.queryByText(/isn't signed in/)).not.toBeInTheDocument();
  });
});
