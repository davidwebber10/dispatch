import { render, screen } from '@testing-library/react';
import { vi, beforeEach, afterEach, test, expect } from 'vitest';
import { ProjectSidebar } from './ProjectSidebar';
import { useProjects } from '../../stores/projects';
import { useTabs } from '../../stores/tabs';
import { api } from '../../api/client';

beforeEach(() => {
  vi.spyOn(api, 'listTerminals').mockResolvedValue([
    { id: 't1', sessionId: 's1', type: 'claude-code', label: 'main', status: 'working' } as any,
  ]);
});
afterEach(() => vi.restoreAllMocks());

test('renders a card per session and its threads', async () => {
  useProjects.setState({
    sessions: [{ id: 's1', name: 'alpha', workingDir: '/srv/repo', status: 'working' } as any],
    activeId: 's1',
  });
  useTabs.setState({
    byProject: { s1: [{ id: 't1', sessionId: 's1', type: 'claude-code', label: 'main', status: 'working' } as any] },
    activeTabId: null,
  });
  render(<ProjectSidebar onSelectTab={() => {}} />);
  expect(await screen.findByText('alpha')).toBeInTheDocument();
  expect(screen.getByText('main')).toBeInTheDocument();
});
