import { expect, test, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ProjectCard } from './ProjectCard';
import { useTabs } from '../../stores/tabs';
import { useListSort } from '../../stores/listSort';
import { useSettings } from '../../stores/settings';
import { api } from '../../api/client';

// Same stand-in as ProjectCard.limits.test.tsx — real dnd-kit gestures are brittle in jsdom.
vi.mock('../common/SortableList', () => ({
  SortableList: ({ items, renderItem }: any) => (
    <div>{items.map((it: any) => <div key={it.id}>{renderItem(it, { dragging: false })}</div>)}</div>
  ),
}));

const SID = 's1';
const session = { id: SID, name: 'Proj', workingDir: '/tmp', status: 'idle', createdAt: '2026-01-01T00:00:00.000Z' } as any;

// Month encodes age: f1 is the oldest, fN the newest. Server order is oldest-first
// (sort_order ASC, created_at ASC), which is exactly the bug being fixed.
function file(i: number) {
  const month = String(i).padStart(2, '0');
  return { id: `f${month}`, sessionId: SID, type: 'file', label: `file-${i}.md`, status: 'idle', createdAt: `2026-${month}-01T00:00:00.000Z`, lastActivityAt: null, config: {}, archivedAt: null, sortOrder: 0 } as any;
}
function thread(i: number) {
  const month = String(i).padStart(2, '0');
  return { id: `t${month}`, sessionId: SID, type: 'claude-code', label: `thread ${i}`, status: 'idle', createdAt: `2026-${month}-01T00:00:00.000Z`, lastActivityAt: null, config: {}, archivedAt: null, sortOrder: 0 } as any;
}
const files = (n: number) => Array.from({ length: n }, (_, i) => file(i + 1));

const rowIds = () => screen.getAllByRole('button').filter((b) => b.hasAttribute('data-thread-id')).map((b) => b.getAttribute('data-thread-id'));
const fileIds = () => rowIds().filter((id) => id!.startsWith('f'));

beforeEach(() => {
  localStorage.clear();
  useListSort.setState({ threads: {}, agents: {} });
  useSettings.setState({ sidebarMaxThreads: 10, sidebarMaxFiles: 10 });
  useTabs.setState({ byProject: {}, loading: {}, activeTabId: null } as any);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function renderCard() {
  render(<ProjectCard session={session} active open onSelectTab={() => {}} />);
}

test('files render newest first by default, not in server (oldest-first) order', () => {
  useTabs.setState({ byProject: { [SID]: files(4) }, loading: {} } as any);
  renderCard();
  expect(fileIds()).toEqual(['f04', 'f03', 'f02', 'f01']);
});

test('the thread sort mode also drives the FILES section', () => {
  useListSort.setState({ threads: { [SID]: 'oldest' }, agents: {} });
  // Shuffled on purpose: the array order must not be what the assertion expects.
  useTabs.setState({ byProject: { [SID]: [file(3), file(1), file(4), file(2)] }, loading: {} } as any);
  renderCard();
  expect(fileIds()).toEqual(['f01', 'f02', 'f03', 'f04']);
});

test('name mode sorts files by label', () => {
  useListSort.setState({ threads: { [SID]: 'name' }, agents: {} });
  const items = [file(1), file(2), file(3)];
  items[0].label = 'zeta.md';
  items[1].label = 'alpha.md';
  items[2].label = 'beta.md';
  useTabs.setState({ byProject: { [SID]: items }, loading: {} } as any);
  renderCard();
  expect(fileIds()).toEqual(['f02', 'f03', 'f01']);
});

test('the cap keeps the newest N files, hiding the oldest behind Show more', () => {
  useSettings.setState({ sidebarMaxFiles: 3 });
  useTabs.setState({ byProject: { [SID]: files(5) }, loading: {} } as any);
  renderCard();
  expect(fileIds()).toEqual(['f05', 'f04', 'f03']);
  expect(screen.getByText('Show 2 more')).toBeInTheDocument();
});

test('the default (custom) mode still leaves threads in server order', () => {
  useTabs.setState({ byProject: { [SID]: [thread(1), thread(2), file(1), file(2)] }, loading: {} } as any);
  renderCard();
  expect(rowIds().filter((id) => id!.startsWith('t'))).toEqual(['t01', 't02']); // untouched
  expect(fileIds()).toEqual(['f02', 'f01']); // newest first
});
