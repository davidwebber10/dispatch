import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProjectFilter } from './ProjectFilter';
import { useEndless } from '../../stores/endless';
import { useProjects } from '../../stores/projects';
import { api } from '../../api/client';

beforeAll(() => {
  class Noop { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Noop;
});

const project = (id: string, name: string, messages: number) => ({ id, name, folder: `/w/${name}`, live: 0, needsYou: 0, openItems: 0, lastReport: null, messages });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'endlessMessages').mockResolvedValue({ messages: [], hasMore: false, hasMoreAfter: false });
  useEndless.setState({ filter: null, atTail: true, projects: [project('s1', 'salsify', 3), project('s2', 'quiet', 0), project('s3', 'dispatch', 1)] });
  useProjects.setState({ sessions: [{ id: 's1', name: 'salsify' }, { id: 's3', name: 'dispatch' }] as any });
});

describe('ProjectFilter', () => {
  it('shows All plus one button per project with messages, and filters on click', async () => {
    render(<ProjectFilter />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['All', 'salsify', 'dispatch']);
    fireEvent.click(screen.getByRole('button', { name: 'dispatch' }));
    await waitFor(() => expect(useEndless.getState().filter).toBe('s3'));
    expect(api.endlessMessages).toHaveBeenCalledWith({ limit: 60, project: 's3' });
  });
});
