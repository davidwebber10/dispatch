import { expect, test, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import { ProjectCard } from './ProjectCard';
import { useTabs } from '../../stores/tabs';
import { useListSort } from '../../stores/listSort';
import { api } from '../../api/client';

// Real dnd-kit pointer/keyboard drag gestures are brittle in jsdom (see
// SortableList.test.tsx). To exercise ProjectCard's actual onReorder wiring —
// not a reimplementation of it in the test — replace SortableList with a
// stand-in that renders the same items via the same renderItem callback but
// exposes a button that invokes the real onReorder prop with a fixed drop
// order. This still drives the exact code in ProjectCard.tsx and listSort.ts.
vi.mock('../common/SortableList', () => ({
  SortableList: ({ items, onReorder, renderItem }: any) => (
    <div>
      <button data-testid="simulate-drop-ba" onClick={() => onReorder(['b', 'a'])}>simulate drop</button>
      {items.map((it: any) => <div key={it.id}>{renderItem(it, { dragging: false })}</div>)}
    </div>
  ),
}));

const SID = 's1';
const session = { id: SID, name: 'Proj', workingDir: '/tmp', status: 'idle', createdAt: '2026-01-01T00:00:00.000Z' } as any;

function term(id: string, label: string, createdAt: string) {
  return { id, sessionId: SID, type: 'claude-code', label, status: 'idle', createdAt, lastActivityAt: createdAt, config: {}, archivedAt: null, sortOrder: 0 } as any;
}

const rowIds = () => screen.getAllByRole('button').filter((b) => b.hasAttribute('data-thread-id')).map((b) => b.getAttribute('data-thread-id'));

beforeEach(() => {
  localStorage.clear();
  useListSort.setState({ threads: {}, agents: {} });
  vi.spyOn(api, 'listTerminals').mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function renderCard() {
  render(<ProjectCard session={session} active open onSelectTab={() => {}} />);
}

test('the sort button is hidden with a single thread', () => {
  useTabs.setState({ byProject: { [SID]: [term('a', 'zeta', '2026-01-01T00:00:00.000Z')] }, loading: {} } as any);
  renderCard();
  expect(screen.queryByLabelText('Sort')).toBeNull();
});

test('the sort button appears once there are two threads', () => {
  useTabs.setState({ byProject: { [SID]: [term('a', 'zeta', '2026-01-01T00:00:00.000Z'), term('b', 'alpha', '2026-02-01T00:00:00.000Z')] }, loading: {} } as any);
  renderCard();
  expect(screen.getByLabelText('Sort')).toBeInTheDocument();
});

test('choosing Name (A-Z) reorders the rendered rows', () => {
  useTabs.setState({ byProject: { [SID]: [term('a', 'zeta', '2026-01-01T00:00:00.000Z'), term('b', 'alpha', '2026-02-01T00:00:00.000Z')] }, loading: {} } as any);
  renderCard();
  const before = rowIds();
  expect(before).toEqual(['a', 'b']);           // custom default = array order

  fireEvent.click(screen.getByLabelText('Sort'));
  fireEvent.click(screen.getByText(/Name \(A/));

  const after = rowIds();
  expect(after).toEqual(['b', 'a']);            // alpha before zeta
  expect(useListSort.getState().threadSort(SID)).toBe('name');
});

test('the threads tab offers the thread option set including Custom', () => {
  useTabs.setState({ byProject: { [SID]: [term('a', 'zeta', '2026-01-01T00:00:00.000Z'), term('b', 'alpha', '2026-02-01T00:00:00.000Z')] }, loading: {} } as any);
  renderCard();
  fireEvent.click(screen.getByLabelText('Sort'));
  const panel = screen.getByTestId('sort-menu-panel');
  expect(within(panel).getByText(/Needs you first/)).toBeInTheDocument();
  expect(within(panel).getByText(/Custom/)).toBeInTheDocument();
});

// Regression test for Finding 1 (Critical): dragging under 'custom' visibly snapped back.
// useTabs.reorder() optimistically reorders the byProject ARRAY without rewriting the
// sortOrder FIELD on the objects — both threads here tie at sortOrder: 0. Dropping to
// ['b', 'a'] drives ProjectCard's real onReorder handler (via the SortableList stand-in
// above), which flips the mode to 'custom' (already the default here) and calls
// useTabs.getState().reorder(). If sortThreads('custom') re-derives order from the
// sortOrder field (the old, wrong behavior), the rendered rows stay ['a', 'b']. This test
// FAILS before the Finding 1 fix (listSort.ts 'custom' case returning `out` unsorted) and
// PASSES after.
test('a successful drop under custom sort renders rows in the dropped order', async () => {
  const initial = [term('a', 'zeta', '2026-01-01T00:00:00.000Z'), term('b', 'alpha', '2026-02-01T00:00:00.000Z')];
  useTabs.setState({ byProject: { [SID]: initial }, loading: {} } as any);
  vi.spyOn(api, 'reorderTerminals').mockResolvedValue(undefined as any);
  // ProjectCard's mount effect calls loadTabs(), which awaits api.listTerminals(); once the
  // test awaits anything (waitFor below), that promise settles and would otherwise clobber
  // byProject back to the beforeEach default of []. Match it to the state set above so it's
  // a no-op refresh instead of a competing write.
  vi.spyOn(api, 'listTerminals').mockResolvedValue(initial as any);
  renderCard();
  expect(useListSort.getState().threadSort(SID)).toBe('custom');
  expect(rowIds()).toEqual(['a', 'b']);

  fireEvent.click(screen.getByTestId('simulate-drop-ba'));

  await waitFor(() => expect(rowIds()).toEqual(['b', 'a']));
  expect(useListSort.getState().threadSort(SID)).toBe('custom');
});

// Regression test for Finding 2 (Important): a failed reorder left the sort mode stuck on
// 'custom' even though the drag never actually committed anything the user picked. Starts
// on 'name', drops (which flips to 'custom' optimistically), and the API call rejects —
// ProjectCard's onReorder handler must restore 'name' once reorder() reports failure.
test('a failed drop restores the previous sort mode instead of leaving it on custom', async () => {
  useTabs.setState({ byProject: { [SID]: [term('a', 'zeta', '2026-01-01T00:00:00.000Z'), term('b', 'alpha', '2026-02-01T00:00:00.000Z')] }, loading: {} } as any);
  useListSort.getState().setThreadSort(SID, 'name');
  vi.spyOn(api, 'reorderTerminals').mockRejectedValue(new Error('network blip'));
  vi.spyOn(api, 'listTerminals').mockResolvedValue([term('a', 'zeta', '2026-01-01T00:00:00.000Z'), term('b', 'alpha', '2026-02-01T00:00:00.000Z')] as any);
  renderCard();
  expect(useListSort.getState().threadSort(SID)).toBe('name');

  fireEvent.click(screen.getByTestId('simulate-drop-ba'));
  // The optimistic flip happens synchronously, before the rejected API call settles.
  expect(useListSort.getState().threadSort(SID)).toBe('custom');

  await waitFor(() => expect(useListSort.getState().threadSort(SID)).toBe('name'));
});
