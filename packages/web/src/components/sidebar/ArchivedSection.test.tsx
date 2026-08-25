import { expect, test, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { ArchivedSection } from './ArchivedSection';
import { useTabs } from '../../stores/tabs';
import { api } from '../../api/client';

const SID = 's1';
function arch(id: string, label: string, archivedAt: string, type = 'claude-code') {
  return { id, sessionId: SID, type, label, status: 'waiting', createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: archivedAt, config: {}, archivedAt, sortOrder: 0, externalId: null, pid: null } as any;
}

beforeEach(() => {
  useTabs.setState({ byProject: {}, loading: {}, activeTabId: null } as any);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function renderSection(onSelectTab: (id: string) => void = () => {}) {
  render(<ArchivedSection sessionId={SID} open onSelectTab={onSelectTab} />);
}

test('renders nothing when the project has no archived threads', async () => {
  const spy = vi.spyOn(api, 'listArchivedTerminals').mockResolvedValue([]);
  renderSection();
  await waitFor(() => expect(spy).toHaveBeenCalledWith(SID));
  expect(screen.queryByText('ARCHIVED')).not.toBeInTheDocument();
});

test('does not fetch while the card is closed', async () => {
  const spy = vi.spyOn(api, 'listArchivedTerminals').mockResolvedValue([]);
  render(<ArchivedSection sessionId={SID} open={false} onSelectTab={() => {}} />);
  await new Promise((r) => setTimeout(r, 10));
  expect(spy).not.toHaveBeenCalled();
});

test('file rows are excluded from the list and the count', async () => {
  vi.spyOn(api, 'listArchivedTerminals').mockResolvedValue([
    arch('a1', 'old thread', '2026-08-20T00:00:00.000Z'),
    arch('f1', 'notes.md', '2026-08-21T00:00:00.000Z', 'file'),
  ]);
  renderSection();
  expect(await screen.findByText('ARCHIVED')).toBeInTheDocument();
  expect(screen.getByText('1')).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('Toggle archived threads'));
  expect(screen.getByText('old thread')).toBeInTheDocument();
  expect(screen.queryByText('notes.md')).not.toBeInTheDocument();
});

test('expands on click, sorts newest first, caps at 10 with Show more', async () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    arch(`a${i + 1}`, `thread ${i + 1}`, `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`));
  vi.spyOn(api, 'listArchivedTerminals').mockResolvedValue(many);
  renderSection();
  expect(await screen.findByText('ARCHIVED')).toBeInTheDocument();
  expect(document.querySelectorAll('[data-archived-id]')).toHaveLength(0); // collapsed by default
  fireEvent.click(screen.getByLabelText('Toggle archived threads'));
  const rows = Array.from(document.querySelectorAll('[data-archived-id]'));
  expect(rows).toHaveLength(10);
  expect(rows[0].getAttribute('data-archived-id')).toBe('a12'); // newest archivedAt first
  fireEvent.click(screen.getByText('Show 2 more'));
  expect(document.querySelectorAll('[data-archived-id]')).toHaveLength(12);
});

test('restore removes the row, reloads tabs, and selects the thread', async () => {
  vi.spyOn(api, 'listArchivedTerminals').mockResolvedValue([arch('a1', 'old thread', '2026-08-20T00:00:00.000Z')]);
  vi.spyOn(api, 'restoreTerminal').mockResolvedValue(arch('a1', 'old thread', '2026-08-20T00:00:00.000Z'));
  const listTerminals = vi.spyOn(api, 'listTerminals').mockResolvedValue([]);
  const onSelect = vi.fn();
  renderSection(onSelect);
  fireEvent.click(await screen.findByLabelText('Toggle archived threads'));
  const row = document.querySelector('[data-archived-id="a1"]') as HTMLElement;
  fireEvent.mouseEnter(row);
  fireEvent.click(screen.getByLabelText('Restore old thread'));
  await waitFor(() => expect(onSelect).toHaveBeenCalledWith('a1'));
  expect(api.restoreTerminal).toHaveBeenCalledWith('a1');
  expect(listTerminals).toHaveBeenCalledWith(SID);
  expect(document.querySelector('[data-archived-id="a1"]')).toBeNull();
});

test('a failed restore keeps the row and shows an inline error', async () => {
  vi.spyOn(api, 'listArchivedTerminals').mockResolvedValue([arch('a1', 'old thread', '2026-08-20T00:00:00.000Z')]);
  vi.spyOn(api, 'restoreTerminal').mockRejectedValue(new Error('nope'));
  renderSection();
  fireEvent.click(await screen.findByLabelText('Toggle archived threads'));
  const row = document.querySelector('[data-archived-id="a1"]') as HTMLElement;
  fireEvent.mouseEnter(row);
  fireEvent.click(screen.getByLabelText('Restore old thread'));
  expect(await screen.findByText('Restore failed')).toBeInTheDocument();
  expect(document.querySelector('[data-archived-id="a1"]')).not.toBeNull();
});

test('a failed fetch shows a retry row that refetches', async () => {
  const spy = vi.spyOn(api, 'listArchivedTerminals')
    .mockRejectedValueOnce(new Error('boom'))
    .mockResolvedValue([arch('a1', 'old thread', '2026-08-20T00:00:00.000Z')]);
  renderSection();
  fireEvent.click(await screen.findByLabelText('Toggle archived threads'));
  fireEvent.click(await screen.findByText("Couldn't load archived threads. Retry."));
  expect(await screen.findByText('old thread')).toBeInTheDocument();
  expect(spy).toHaveBeenCalledTimes(2);
});

test('refetches when the live tab-id set changes', async () => {
  const spy = vi.spyOn(api, 'listArchivedTerminals').mockResolvedValue([]);
  renderSection();
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  act(() => {
    useTabs.setState({ byProject: { [SID]: [arch('t1', 'live', '2026-08-20T00:00:00.000Z')] }, loading: {} } as any);
  });
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
});
