// The inline control-plane setup card: shown instead of an auto-created coordinator when
// ensureForProject peeks a project and finds none (store's `setupNeeded`). Lets the user pick
// the worker harness (the agents this coordinator will spawn) and its own model before the
// first directive, then Start creates the coordinator with that selection (store.startCoordinator).
import { render, screen, within, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useOverseer } from '../store';
import { useProjects } from '../../../stores/projects';
import { api } from '../../../api/client';
import { HARNESSES } from '../../../lib/harnesses';
import { ControlPlaneSetupCard } from './SetupCard';

vi.mock('../../../api/client', () => ({
  api: { getHarnessCapabilities: vi.fn(), recheckProviders: vi.fn() },
}));

// The four agent harnesses (everything but the plain shell), shaped like the daemon's
// GET /api/setup/harnesses response — only `id`/`modes`/`capabilities.coordinator` are read
// by the card. `coordinator` mirrors the daemon's real allowlist (Claude + Codex only).
const AGENT_CAPS = HARNESSES.filter((h) => h.id !== 'terminal').map((h) => ({
  ...h,
  capabilities: { resume: false, branch: false, permissions: false, telemetry: { structured: true, pty: true }, coordinator: h.id === 'claude' || h.id === 'codex' },
}));

beforeEach(() => {
  (api.getHarnessCapabilities as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(AGENT_CAPS);
  // Default: every provider installed, so existing tests keep asserting on capabilities
  // filtering alone. Tests below override this to exercise the install-state dimming.
  (api.recheckProviders as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
    { name: 'claude', installed: true, signedIn: true },
    { name: 'codex', installed: true, signedIn: true },
    { name: 'grok', installed: true, signedIn: true },
    { name: 'opencode', installed: true, signedIn: true },
  ]);
  useProjects.setState({ activeId: 'p1' });
  useOverseer.setState({
    setupNeeded: true,
    coordinatorProject: 'p1',
    setupSelection: { workerHarness: 'claude-code', model: 'sonnet', coordinatorHarness: 'claude-code' },
    ensuring: false,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ControlPlaneSetupCard', () => {
  it('renders the Workers strip (four agent harnesses, no Terminal pill) and Sonnet preselected', async () => {
    render(<ControlPlaneSetupCard />);
    await waitFor(() => expect(api.getHarnessCapabilities).toHaveBeenCalled());
    const workers = within(screen.getByTestId('workers-strip'));
    expect(workers.getByText('Claude Code')).toBeInTheDocument();
    expect(workers.getByText('Codex')).toBeInTheDocument();
    expect(workers.getByText('Grok')).toBeInTheDocument();
    expect(workers.getByText('OpenCode')).toBeInTheDocument();
    expect(workers.queryByText('Terminal')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Coordinator model' })).toHaveTextContent('Sonnet');
  });

  it('selecting Codex updates the store: setupSelection.workerHarness === "codex"', async () => {
    render(<ControlPlaneSetupCard />);
    await waitFor(() => expect(api.getHarnessCapabilities).toHaveBeenCalled());
    const workers = within(screen.getByTestId('workers-strip'));
    fireEvent.click(workers.getByRole('button', { name: /Codex/ }));
    expect(useOverseer.getState().setupSelection.workerHarness).toBe('codex');
  });

  it('Start calls startCoordinator with the active project id', async () => {
    const startCoordinator = vi.fn().mockResolvedValue(undefined);
    useOverseer.setState({ startCoordinator, coordinatorProject: 'p1' });
    render(<ControlPlaneSetupCard />);
    await waitFor(() => expect(api.getHarnessCapabilities).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(startCoordinator).toHaveBeenCalledWith('p1');
  });

  it('dims a harness and tags it Install when its provider is reported not installed', async () => {
    (api.recheckProviders as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'claude', installed: true, signedIn: true },
      { name: 'codex', installed: false, signedIn: false },
      { name: 'grok', installed: true, signedIn: true },
      { name: 'opencode', installed: true, signedIn: true },
    ]);
    render(<ControlPlaneSetupCard />);
    await waitFor(() => expect(api.recheckProviders).toHaveBeenCalled());
    const workers = within(screen.getByTestId('workers-strip'));
    await waitFor(() => expect(workers.getByText('Install')).toBeInTheDocument());
    expect(workers.getByRole('button', { name: /Codex/ }).getAttribute('title')).toContain('not installed');
  });

  it('renders the Coordinator strip with only Claude + Codex (Grok/OpenCode absent — coordinator:false)', async () => {
    render(<ControlPlaneSetupCard />);
    await waitFor(() => expect(api.getHarnessCapabilities).toHaveBeenCalled());
    const coordinator = within(screen.getByTestId('coordinator-strip'));
    expect(coordinator.getByText('Claude Code')).toBeInTheDocument();
    expect(coordinator.getByText('Codex')).toBeInTheDocument();
    expect(coordinator.queryByText('Grok')).not.toBeInTheDocument();
    expect(coordinator.queryByText('OpenCode')).not.toBeInTheDocument();
  });

  it('selecting Codex on the Coordinator strip updates the store and swaps the model options to Codex\'s list', async () => {
    render(<ControlPlaneSetupCard />);
    await waitFor(() => expect(api.getHarnessCapabilities).toHaveBeenCalled());
    const coordinator = within(screen.getByTestId('coordinator-strip'));
    fireEvent.click(coordinator.getByRole('button', { name: /Codex/ }));
    expect(useOverseer.getState().setupSelection.coordinatorHarness).toBe('codex');
    // Codex's own "Default" model, not Claude's "Sonnet" — the model select re-sourced
    // its options from the newly-selected coordinator harness's own model list.
    expect(screen.getByRole('combobox', { name: 'Coordinator model' })).toHaveTextContent('Default');
    fireEvent.click(screen.getByRole('combobox', { name: 'Coordinator model' }));
    expect(screen.getByText('6 Astra')).toBeInTheDocument();
    expect(screen.queryByText('Sonnet')).not.toBeInTheDocument();
  });
  // M3 is fixed (each Codex thread carries its own Dispatch MCP identity), so a Codex coordinator
  // can run Codex workers: the card must keep offering them.
  it('a Codex coordinator keeps Codex in the Workers strip and keeps a Codex worker pick', async () => {
    useOverseer.setState({ setupSelection: { workerHarness: 'codex', model: 'sonnet', coordinatorHarness: 'claude-code' } });
    render(<ControlPlaneSetupCard />);
    await waitFor(() => expect(api.getHarnessCapabilities).toHaveBeenCalled());
    fireEvent.click(within(screen.getByTestId('coordinator-strip')).getByRole('button', { name: /Codex/ }));
    await new Promise((r) => setTimeout(r, 50));
    expect(useOverseer.getState().setupSelection.workerHarness).toBe('codex');
    const workers = within(screen.getByTestId('workers-strip'));
    expect(workers.getByText('Codex')).toBeInTheDocument();
    expect(workers.queryByText(/Codex workers/i)).not.toBeInTheDocument();
  });

  // L2: the seed marks Codex coordinator-capable before the probe answers; if the probe then says
  // it is not (e.g. DISPATCH_CODEX_PRETTY=0), a Codex pick must not linger invisibly and fail Start.
  it('resets a stale Codex coordinator pick when the probe reports Codex cannot coordinate', async () => {
    (api.getHarnessCapabilities as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      AGENT_CAPS.map((h) => ({ ...h, capabilities: { ...h.capabilities, coordinator: h.id === 'claude' } })),
    );
    useOverseer.setState({ setupSelection: { workerHarness: 'claude-code', model: '', coordinatorHarness: 'codex' } });
    render(<ControlPlaneSetupCard />);
    await waitFor(() => expect(useOverseer.getState().setupSelection.coordinatorHarness).toBe('claude-code'));
    expect(useOverseer.getState().setupSelection.model).toBe('sonnet');
  });

  it('shows the Start failure under the button', async () => {
    useOverseer.setState({ setupError: 'Could not start the coordinator.' });
    render(<ControlPlaneSetupCard />);
    await waitFor(() => expect(api.getHarnessCapabilities).toHaveBeenCalled());
    expect(screen.getByRole('alert')).toHaveTextContent('Could not start the coordinator.');
  });
});
