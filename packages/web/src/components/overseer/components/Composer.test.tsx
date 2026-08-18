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
