import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProjectsPanel } from './ProjectsPanel';
import { useEndless } from '../../stores/endless';
import { api } from '../../api/client';

let saved: ReturnType<typeof useEndless.getState>;

beforeEach(() => {
  saved = useEndless.getState();
  useEndless.setState({ projects: [
    { id: 's1', name: 'salsify', folder: '/w/salsify', live: 2, needsYou: 1, openItems: 3, lastReport: '[Fixer] report: tests pass', messages: 5 },
    { id: 's2', name: 'idle', folder: '/w/idle', live: 0, needsYou: 0, openItems: 0, lastReport: null, messages: 0 },
  ] });
});

afterEach(() => {
  vi.restoreAllMocks();
  useEndless.setState(saved, true);
});

describe('ProjectsPanel', () => {
  it('shows live and needs-you counts, open items, and the last report for projects with activity', () => {
    render(<ProjectsPanel />);
    const card = screen.getByTestId('project-s1');
    expect(card).toHaveTextContent('salsify');
    expect(card).toHaveTextContent('2 live · 1 need you · 3 open');
    expect(card).toHaveTextContent('[Fixer] report: tests pass');
    expect(screen.queryByTestId('project-s2')).not.toBeInTheDocument();
  });
  it('refreshes on demand', () => {
    const spy = vi.spyOn(api, 'endlessProjects').mockResolvedValue([]);
    render(<ProjectsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh projects' }));
    expect(spy).toHaveBeenCalled();
  });
  it('shows an empty note and survives a failed refresh', () => {
    useEndless.setState({ projects: [] });
    vi.spyOn(api, 'endlessProjects').mockRejectedValue(new Error('503'));
    render(<ProjectsPanel />);
    expect(screen.getByText('No project activity yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh projects' }));
  });
});
