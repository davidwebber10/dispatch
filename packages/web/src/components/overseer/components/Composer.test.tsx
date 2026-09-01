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
