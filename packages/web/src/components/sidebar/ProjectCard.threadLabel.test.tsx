// Finding 3: reverting ProjectCard's `<ThreadLabel tab={tab} />` (ProjectCard.tsx ~line 131,
// inside ThreadRow) back to the original `<span>{tab.label}</span>` passes the ENTIRE web
// suite — ThreadLabel.test.tsx exercises the component directly, and ThreadRow.autoArchive
// .test.tsx / ProjectSidebar.test.tsx only assert with getByText, which matches either markup.
// Route a real default->auto transition through the actual ProjectCard tree (SortableList ->
// ThreadRow -> ThreadLabel) and assert on `.dispatch-caret`, which only ThreadLabel ever
// renders — this fails immediately if the wiring is reverted.
import { expect, test, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProjectCard } from './ProjectCard';
import { useTabs } from '../../stores/tabs';
import { api } from '../../api/client';
import type { Session, Terminal } from '../../api/types';

const NOW = new Date('2026-07-19T12:00:00.000Z').getTime();

const session: Session = {
  id: 's1', provider: 'claude-code', name: 'proj', notes: '', status: 'waiting',
  workingDir: '/tmp/proj', tags: [], pid: null, createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z', lastActivityAt: '2026-07-14T00:00:00.000Z', archivedAt: null,
};

const thread: Terminal = {
  id: 't1', sessionId: 's1', type: 'claude-code', label: 'Fix login bug', labelSource: 'auto',
  pid: null, externalId: null, workingDir: null, status: 'waiting',
  createdAt: '2026-07-14T11:00:00.000Z', lastActivityAt: '2026-07-14T11:00:00.000Z', config: {}, archivedAt: null, sortOrder: 0,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  // ProjectCard's mount effect calls loadTabs → api.listTerminals; stub it so the component
  // doesn't fire a real fetch() (unhandled rejection under jsdom) and clobber the byProject /
  // autoNamed fixtures seeded below before the layout effect gets a chance to run.
  vi.spyOn(api, 'listTerminals').mockResolvedValue([]);
  useTabs.setState({
    byProject: { s1: [thread] },
    autoNamed: { t1: { from: 'Claude Code', to: 'Fix login bug', at: NOW } },
    loading: {},
  } as any);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test('a thread with a live default->auto transition renders through ThreadLabel (not a plain span) inside ProjectCard', () => {
  render(<ProjectCard session={session} active open onSelectTab={() => {}} />);
  // Only ThreadLabel ever renders a caret — a plain `<span>{tab.label}</span>` cannot.
  expect(document.querySelector('.dispatch-caret')).not.toBeNull();
  // The true label is still exposed to assistive tech while the animation plays.
  expect(screen.getByLabelText('Fix login bug')).toBeInTheDocument();
});
