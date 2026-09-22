// The inline control-plane setup card: shown instead of an auto-created coordinator when
// ensureForProject peeks a project and finds none (store's `setupNeeded`). Lets the user pick
// the worker harness (the agents this coordinator will spawn) and its own model before the
// first directive, then Start creates the coordinator with that selection (store.startCoordinator).
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useOverseer } from '../store';
import { useProjects } from '../../../stores/projects';
import { api } from '../../../api/client';
import { HARNESSES } from '../../../lib/harnesses';
import { ControlPlaneSetupCard } from './SetupCard';

vi.mock('../../../api/client', () => ({
  api: { getHarnessCapabilities: vi.fn() },
}));

// The four agent harnesses (everything but the plain shell), shaped like the daemon's
// GET /api/setup/harnesses response — only `id`/`modes` are read by the card.
const AGENT_CAPS = HARNESSES.filter((h) => h.id !== 'terminal').map((h) => ({
  ...h,
  capabilities: { resume: false, branch: false, permissions: false, telemetry: { structured: true, pty: true } },
}));

beforeEach(() => {
  (api.getHarnessCapabilities as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(AGENT_CAPS);
  useProjects.setState({ activeId: 'p1' });
  useOverseer.setState({
    setupNeeded: true,
    coordinatorProject: 'p1',
    setupSelection: { workerHarness: 'claude-code', model: 'sonnet' },
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
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.getByText('Grok')).toBeInTheDocument();
    expect(screen.getByText('OpenCode')).toBeInTheDocument();
    expect(screen.queryByText('Terminal')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Coordinator model' })).toHaveTextContent('Sonnet');
  });

  it('selecting Codex updates the store: setupSelection.workerHarness === "codex"', async () => {
    render(<ControlPlaneSetupCard />);
    await waitFor(() => expect(api.getHarnessCapabilities).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Codex/ }));
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
});
