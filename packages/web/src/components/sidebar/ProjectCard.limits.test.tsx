import { expect, test, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ProjectCard } from './ProjectCard';
import { useTabs } from '../../stores/tabs';
import { useListSort } from '../../stores/listSort';
import { useSettings } from '../../stores/settings';
import { api } from '../../api/client';

// Same stand-in as ProjectCard.sort.test.tsx: real dnd-kit gestures are brittle in jsdom,
// so drive ProjectCard's actual onReorder prop directly. The drop button hands back the
// VISIBLE items reversed — exactly what a real drag over a truncated list produces.
vi.mock('../common/SortableList', () => ({
  SortableList: ({ items, onReorder, renderItem }: any) => (
    <div>
      <button data-testid="simulate-drop-reverse" onClick={() => onReorder(items.map((i: any) => i.id).slice().reverse())}>simulate drop</button>
      {items.map((it: any) => <div key={it.id}>{renderItem(it, { dragging: false })}</div>)}
    </div>
  ),
}));

const SID = 's1';
const session = { id: SID, name: 'Proj', workingDir: '/tmp', status: 'idle', createdAt: '2026-01-01T00:00:00.000Z' } as any;

function term(id: string, label: string, type = 'claude-code') {
  return { id, sessionId: SID, type, label, status: 'idle', createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z', config: {}, archivedAt: null, sortOrder: 0 } as any;
}

// Ids sort naturally: t01…t12. Default thread sort is 'custom' = array order.
const threads = (n: number) => Array.from({ length: n }, (_, i) => term(`t${String(i + 1).padStart(2, '0')}`, `thread ${i + 1}`));

const rowIds = () => screen.getAllByRole('button').filter((b) => b.hasAttribute('data-thread-id')).map((b) => b.getAttribute('data-thread-id'));

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

test('caps the thread list at the limit and offers the remainder behind Show more', () => {
  useTabs.setState({ byProject: { [SID]: threads(12) }, loading: {} } as any);
  renderCard();
  expect(rowIds()).toHaveLength(10);
  expect(screen.getByText('Show 2 more')).toBeInTheDocument();
  // The THREADS pill still counts the full list, not the visible slice.
  expect(screen.getByText('12')).toBeInTheDocument();
});

test('clicking Show more reveals the full list and removes the expander', () => {
  useTabs.setState({ byProject: { [SID]: threads(12) }, loading: {} } as any);
  renderCard();
  fireEvent.click(screen.getByText('Show 2 more'));
  expect(rowIds()).toHaveLength(12);
  expect(screen.queryByText('Show 2 more')).not.toBeInTheDocument();
});

test('no expander when the list fits within the limit', () => {
  useTabs.setState({ byProject: { [SID]: threads(10) }, loading: {} } as any);
  renderCard();
  expect(rowIds()).toHaveLength(10);
  expect(screen.queryByText(/Show \d+ more/)).not.toBeInTheDocument();
});

test('All (0) disables the cap entirely', () => {
  useSettings.setState({ sidebarMaxThreads: 0 });
  useTabs.setState({ byProject: { [SID]: threads(12) }, loading: {} } as any);
  renderCard();
  expect(rowIds()).toHaveLength(12);
  expect(screen.queryByText(/Show \d+ more/)).not.toBeInTheDocument();
});

test('an active thread past the cut lifts the cap instead of being hidden', () => {
  useTabs.setState({ byProject: { [SID]: threads(12) }, loading: {}, activeTabId: 't12' } as any);
  renderCard();
  expect(rowIds()).toHaveLength(12);
});

test('a drop on the truncated list keeps the hidden tail in the server order', async () => {
  const all = threads(12);
  useTabs.setState({ byProject: { [SID]: all }, loading: {} } as any);
  vi.spyOn(api, 'reorderTerminals').mockResolvedValue(undefined as any);
  vi.spyOn(api, 'listTerminals').mockResolvedValue(all as any);
  renderCard();

  fireEvent.click(screen.getByTestId('simulate-drop-reverse'));

  await waitFor(() => expect(api.reorderTerminals).toHaveBeenCalled());
  const sent: string[] = (api.reorderTerminals as any).mock.calls[0][1];
  expect(sent).toHaveLength(12); // full order, not just the visible slice
  expect(sent.slice(0, 10)).toEqual(['t10', 't09', 't08', 't07', 't06', 't05', 't04', 't03', 't02', 't01']);
  expect(sent.slice(10)).toEqual(['t11', 't12']); // hidden tail preserved, in order
});
