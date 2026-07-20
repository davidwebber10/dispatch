import { expect, test, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { ProjectCard } from './ProjectCard';
import { useTabs } from '../../stores/tabs';
import { useListSort } from '../../stores/listSort';
import { api } from '../../api/client';

const SID = 's1';
const session = { id: SID, name: 'Proj', workingDir: '/tmp', status: 'idle', createdAt: '2026-01-01T00:00:00.000Z' } as any;

function term(id: string, label: string, createdAt: string) {
  return { id, sessionId: SID, type: 'claude-code', label, status: 'idle', createdAt, lastActivityAt: createdAt, config: {}, archivedAt: null, sortOrder: 0 } as any;
}

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
  const before = screen.getAllByRole('button').filter((b) => b.hasAttribute('data-thread-id')).map((b) => b.getAttribute('data-thread-id'));
  expect(before).toEqual(['a', 'b']);           // custom default = sortOrder then createdAt

  fireEvent.click(screen.getByLabelText('Sort'));
  fireEvent.click(screen.getByText(/Name \(A/));

  const after = screen.getAllByRole('button').filter((b) => b.hasAttribute('data-thread-id')).map((b) => b.getAttribute('data-thread-id'));
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
