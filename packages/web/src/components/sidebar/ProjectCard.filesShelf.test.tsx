import { expect, test, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ProjectCard } from './ProjectCard';
import { useTabs } from '../../stores/tabs';
import { useListSort } from '../../stores/listSort';
import { useSectionCollapse } from '../../stores/sectionCollapse';
import { useSettings } from '../../stores/settings';
import { api } from '../../api/client';

vi.mock('../common/SortableList', () => ({
  SortableList: ({ items, renderItem }: any) => (
    <div>{items.map((it: any) => <div key={it.id}>{renderItem(it, { dragging: false })}</div>)}</div>
  ),
}));

const SID = 's1';
const session = { id: SID, name: 'Proj', workingDir: '/tmp', status: 'idle', createdAt: '2026-01-01T00:00:00.000Z' } as any;

function term(id: string, label: string, type = 'claude-code') {
  return { id, sessionId: SID, type, label, status: 'idle', createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z', config: {}, archivedAt: null, sortOrder: 0 } as any;
}

const threads = (n: number) => Array.from({ length: n }, (_, i) => term(`t${i + 1}`, `thread ${i + 1}`));
const files = (n: number) => Array.from({ length: n }, (_, i) => term(`f${i + 1}`, `file-${i + 1}.md`, 'file'));

const rowIds = () => screen.queryAllByRole('button').filter((b) => b.hasAttribute('data-thread-id')).map((b) => b.getAttribute('data-thread-id'));
const fileRows = () => rowIds().filter((id) => id!.startsWith('f'));
const collapseBtn = () => screen.getByRole('button', { name: 'Collapse files' });

// Read at module load, before any beforeEach reset can mask what the store ships with.
const SHIPPED_SHOW_PINNED_FILES = useSettings.getState().showPinnedFiles;

beforeEach(() => {
  localStorage.clear();
  useListSort.setState({ threads: {}, agents: {} });
  useSectionCollapse.setState({ collapsed: {} });
  useSettings.setState({ sidebarMaxThreads: 10, sidebarMaxFiles: 10, showPinnedFiles: true });
  useTabs.setState({ byProject: {}, loading: {}, activeTabId: null } as any);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([]);
  vi.spyOn(api, 'listArchivedTerminals').mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function renderCard() {
  render(<ProjectCard session={session} active open onSelectTab={() => {}} />);
}

/* ── The collapse chevron ─────────────────────────────────────────────── */

test('the FILES shelf starts open — the chevron changes nothing until you click it', () => {
  useTabs.setState({ byProject: { [SID]: files(3) }, loading: {} } as any);
  renderCard();
  expect(fileRows()).toHaveLength(3);
  expect(collapseBtn()).toBeInTheDocument();
});

test('clicking the chevron closes the shelf — the header stays, the files go', () => {
  useTabs.setState({ byProject: { [SID]: files(3) }, loading: {} } as any);
  renderCard();
  fireEvent.click(collapseBtn());
  expect(fileRows()).toHaveLength(0);
  expect(screen.getByText('FILES')).toBeInTheDocument();
});

test('clicking again reopens it to exactly what was there before', () => {
  useTabs.setState({ byProject: { [SID]: files(3) }, loading: {} } as any);
  renderCard();
  fireEvent.click(collapseBtn());
  fireEvent.click(screen.getByRole('button', { name: 'Expand files' }));
  expect(fileRows()).toHaveLength(3);
});

test('a closed shelf hides its Show-more expander too', () => {
  useTabs.setState({ byProject: { [SID]: files(12) }, loading: {} } as any);
  renderCard();
  expect(screen.getByText('Show 2 more')).toBeInTheDocument();
  fireEvent.click(collapseBtn());
  expect(screen.queryByText(/Show \d+ more/)).not.toBeInTheDocument();
});

test('closing FILES leaves the thread list alone', () => {
  useTabs.setState({ byProject: { [SID]: [...threads(2), ...files(3)] }, loading: {} } as any);
  renderCard();
  fireEvent.click(collapseBtn());
  expect(rowIds().filter((id) => id!.startsWith('t'))).toHaveLength(2);
  expect(fileRows()).toHaveLength(0);
});

test('the closed state survives a remount — a shelf you closed stays closed', () => {
  useTabs.setState({ byProject: { [SID]: files(3) }, loading: {} } as any);
  renderCard();
  fireEvent.click(collapseBtn());
  cleanup();
  renderCard();
  expect(fileRows()).toHaveLength(0);
});

test('the collapsed state is per project, not global', () => {
  useSectionCollapse.getState().setCollapsed('other-project', 'files', true);
  useTabs.setState({ byProject: { [SID]: files(3) }, loading: {} } as any);
  renderCard();
  expect(fileRows()).toHaveLength(3);
});

/* ── The "show pinned files" setting ──────────────────────────────────── */

test('turning off Pinned files removes the shelf entirely — header and chevron included', () => {
  useSettings.setState({ showPinnedFiles: false });
  useTabs.setState({ byProject: { [SID]: files(3) }, loading: {} } as any);
  renderCard();
  expect(fileRows()).toHaveLength(0);
  expect(screen.queryByText('FILES')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /files/i })).not.toBeInTheDocument();
});

test('hiding pinned files leaves threads untouched', () => {
  useSettings.setState({ showPinnedFiles: false });
  useTabs.setState({ byProject: { [SID]: [...threads(2), ...files(3)] }, loading: {} } as any);
  renderCard();
  expect(rowIds().filter((id) => id!.startsWith('t'))).toHaveLength(2);
  expect(fileRows()).toHaveLength(0);
});

test('the setting ships on, so an install that never touches it sees no change', () => {
  expect(SHIPPED_SHOW_PINNED_FILES).toBe(true);
});
