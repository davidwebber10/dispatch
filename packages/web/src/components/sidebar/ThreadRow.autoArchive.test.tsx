import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProjectCard } from './ProjectCard';
import { useTabs } from '../../stores/tabs';
import { api } from '../../api/client';
import type { Session, Terminal } from '../../api/types';

const session: Session = {
  id: 's1', provider: 'claude-code', name: 'proj', notes: '', status: 'waiting',
  workingDir: '/tmp/proj', tags: [], pid: null, createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z', lastActivityAt: '2026-07-14T00:00:00.000Z', archivedAt: null,
};

const thread = (id: string, config: Record<string, unknown>, lastActivityAt: string): Terminal => ({
  id, sessionId: 's1', type: 'claude-code', label: id, pid: null, externalId: null, workingDir: null,
  status: 'waiting', createdAt: lastActivityAt, lastActivityAt, config, archivedAt: null, sortOrder: 0,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-14T12:00:00.000Z'));
  // ProjectCard's mount effect calls loadTabs → api.listTerminals; stub it so the
  // component doesn't fire a real fetch() (unhandled rejection under jsdom) and
  // clobber the byProject fixture set up per-test below.
  vi.spyOn(api, 'listTerminals').mockResolvedValue([]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ThreadRow auto-archive badge', () => {
  it('shows the countdown instead of timeAgo for an auto-archive thread', () => {
    useTabs.setState({
      byProject: {
        s1: [thread('t1', { autoArchive: true, autoArchiveMs: 43_200_000 }, '2026-07-14T11:00:00.000Z')],
      },
      loading: {},
    } as any);

    render(<ProjectCard session={session} active open onSelectTab={() => {}} />);
    // Idle 1h of a 12h lease → 11h left.
    expect(screen.getByText('11h')).toBeInTheDocument();
    expect(screen.getByTitle(/archives after 12 hours of inactivity/i)).toBeInTheDocument();
  });

  it('shows plain timeAgo for a thread with no policy', () => {
    useTabs.setState({
      byProject: { s1: [thread('t1', {}, '2026-07-14T11:00:00.000Z')] },
      loading: {},
    } as any);

    render(<ProjectCard session={session} active open onSelectTab={() => {}} />);
    expect(screen.queryByTitle(/archives after/i)).not.toBeInTheDocument();
  });
});
