import { expect, test, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ProjectCard } from './ProjectCard';
import { useTabs } from '../../stores/tabs';
import { useListSort } from '../../stores/listSort';
import { useSettings } from '../../stores/settings';
import { api } from '../../api/client';

const SID = 's1';
const session = { id: SID, name: 'Proj', workingDir: '/tmp', status: 'idle', createdAt: '2026-01-01T00:00:00.000Z' } as any;

beforeEach(() => {
  localStorage.clear();
  useListSort.setState({ threads: {}, agents: {} });
  useSettings.setState({ sidebarMaxThreads: 10, sidebarMaxFiles: 10 });
  useTabs.setState({ byProject: {}, loading: {}, activeTabId: null } as any);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('an open card renders the ARCHIVED section when archived threads exist', async () => {
  vi.spyOn(api, 'listArchivedTerminals').mockResolvedValue([
    { id: 'a1', sessionId: SID, type: 'claude-code', label: 'old thread', status: 'waiting', createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-08-20T00:00:00.000Z', config: {}, archivedAt: '2026-08-20T00:00:00.000Z', sortOrder: 0, externalId: null, pid: null } as any,
  ]);
  render(<ProjectCard session={session} active open onSelectTab={() => {}} />);
  expect(await screen.findByText('ARCHIVED')).toBeInTheDocument();
});

test('a closed card does not fetch the archived list', async () => {
  const spy = vi.spyOn(api, 'listArchivedTerminals').mockResolvedValue([]);
  render(<ProjectCard session={session} active={false} open={false} onSelectTab={() => {}} />);
  await new Promise((r) => setTimeout(r, 10));
  expect(spy).not.toHaveBeenCalled();
});
