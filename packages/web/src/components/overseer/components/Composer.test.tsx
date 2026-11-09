// Composer — cross-project session-menu gating (spec §8). The composer-row
// CoordinatorMenu (⋯) must never render for a coordinator that belongs to
// another project while an ensureForProject swap is mid-flight — same guard as
// every other coordinator read (see store.ts's coordinatorMatchesView doc comment).
// This covers the `showSessionMenu` derivation directly, since nothing else did.
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useOverseer } from '../store';
import { useProjects } from '../../../stores/projects';
import { Composer } from './Composer';

beforeEach(() => {
  useOverseer.setState({
    coordinatorId: 'coord-1',
    coordinatorProject: 'proj-a',
    coordinatorContextTokens: undefined,
    coordinatorCompacting: false,
    coordinatorCompactResult: null,
    coordinatorModel: undefined,
    composerImagesByProject: {},
  } as never);
  useProjects.setState({ activeId: 'proj-a' } as never);
});
afterEach(cleanup);

describe('Composer — session menu gated on coordinatorProject matching the viewed project', () => {
  it('does NOT render the session menu when the loaded coordinator belongs to ANOTHER project than the view', () => {
    useOverseer.setState({ coordinatorProject: 'proj-a' } as never);
    useProjects.setState({ activeId: 'proj-b' } as never);

    render(<Composer />);

    expect(screen.queryByTitle('Session menu')).not.toBeInTheDocument();
  });

  it('renders the session menu once the coordinator project matches the viewed project', () => {
    useOverseer.setState({ coordinatorProject: 'proj-a' } as never);
    useProjects.setState({ activeId: 'proj-a' } as never);

    render(<Composer />);

    expect(screen.getByTitle('Session menu')).toBeInTheDocument();
  });
});

// ---- QoL parity with the agent ChatView composer: disabled-empty Send + Stop mode ----
import { fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import { api } from '../../../api/client';

describe('Composer — Send/Stop key parity', () => {
  // The draft persists per project (useDraft → localStorage), so a previous test's
  // typed text would leak into the next one's canSend.
  beforeEach(() => localStorage.clear());

  it('disables Send while the composer is empty and no image is staged', () => {
    render(<Composer />);
    expect(screen.getByTitle('Send directive')).toBeDisabled();
  });

  it('enables Send once text is typed', () => {
    render(<Composer />);
    fireEvent.change(screen.getByPlaceholderText(/directive/i), { target: { value: 'go' } });
    expect(screen.getByTitle('Send directive')).toBeEnabled();
  });

  it('offers Stop over an empty composer while a turn is in flight, and interrupts on click', () => {
    const spy = vi.spyOn(api, 'interrupt').mockResolvedValue(undefined as never);
    useOverseer.setState({ coordinatorBusy: true } as never);
    render(<Composer />);
    const stop = screen.getByTitle('Stop');
    fireEvent.click(stop);
    expect(spy).toHaveBeenCalledWith('coord-1');
    spy.mockRestore();
  });

  it('typing always wins: a busy turn with a drafted follow-up shows Send, not Stop', () => {
    useOverseer.setState({ coordinatorBusy: true } as never);
    render(<Composer />);
    fireEvent.change(screen.getByPlaceholderText(/directive/i), { target: { value: 'also do this' } });
    expect(screen.getByTitle('Send directive')).toBeInTheDocument();
    expect(screen.queryByTitle('Stop')).not.toBeInTheDocument();
  });
});

// ---- the "/" menu and the model chip for the overseer (rebuild of PR #155 on main 4.3.0) ----
import { waitFor } from '@testing-library/react';
import { useTabs } from '../../../stores/tabs';

describe('Composer — the "/" menu and the model chip', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    useOverseer.setState({ coordinatorId: 'coord-1', coordinatorProject: 'proj-a', coordinatorModel: 'claude-sonnet-5-5', coordinatorBusy: false, coordinatorCompacting: false, sendDirective: vi.fn() } as never);
    useProjects.setState({ activeId: 'proj-a' } as never);
    vi.spyOn(useTabs.getState(), 'loadTabs').mockResolvedValue(undefined as never);
    useTabs.setState({ byProject: { 'proj-a': [{ id: 'coord-1', sessionId: 'proj-a', type: 'claude-code', label: 'CP', pid: 1, externalId: 'e', workingDir: '/w', status: 'waiting', createdAt: '', config: { role: 'coordinator', transport: 'structured', model: 'sonnet' }, archivedAt: null, sortOrder: 0 }] } } as never);
  });
  const box = () => screen.getByPlaceholderText(/Fire a directive/) as HTMLTextAreaElement;

  it('/model opus switches the overseer\'s model through the chip\'s call and is not sent as a directive (PS-2)', async () => {
    const setModel = vi.spyOn(api, 'setThreadModel').mockResolvedValue({ model: 'claude-opus-5-5', terminal: {} as never });
    render(<Composer />);
    fireEvent.change(box(), { target: { value: '/model opus' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(setModel).toHaveBeenCalledWith('coord-1', 'opus'));
    expect(useOverseer.getState().sendDirective).not.toHaveBeenCalled();
  });

  it('/effort max changes the overseer\'s effort', async () => {
    const setEffort = vi.spyOn(api, 'setThreadEffort').mockResolvedValue({ effort: 'max', terminal: {} as never });
    render(<Composer />);
    fireEvent.change(box(), { target: { value: '/effort max' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(setEffort).toHaveBeenCalledWith('coord-1', 'max'));
  });

  it('the status row has the same model chip as a thread, with the effort section', () => {
    render(<Composer />);
    fireEvent.click(screen.getByRole('button', { name: /^Model:/ }));
    expect(screen.getByRole('radiogroup', { name: 'Model' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Effort' })).toBeInTheDocument();
  });

  it('lists /model, /effort, /compact and /stop (no /cli: an overseer has no CLI mode)', () => {
    render(<Composer />);
    fireEvent.change(box(), { target: { value: '/' } });
    expect(screen.getAllByRole('option').map((o) => o.firstElementChild?.textContent)).toEqual(['/model', '/effort', '/compact', '/stop']);
  });

  it('while the overseer works, a bare /model says so instead of opening the card', async () => {
    useOverseer.setState({ coordinatorBusy: true } as never);
    render(<Composer />);
    fireEvent.change(box(), { target: { value: '/model' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/busy — change the model when the turn ends/));
    expect(box().value).toBe('/model');
  });

  it('a normal directive still goes out', () => {
    render(<Composer />);
    fireEvent.change(box(), { target: { value: 'status please' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(useOverseer.getState().sendDirective).toHaveBeenCalledWith('status please');
  });
});
