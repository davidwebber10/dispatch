import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryView, MemorySection } from './MemoryView';
import { api } from '../../api/client';
import { useMemory } from '../../stores/memory';
import type { MemoryNote, MemoryPage, MemoryPageSummary, MemorySettings } from '../../api/types';

const page: MemoryPage = {
  id: 1, scope: 'project:p1', slug: 'deploy', description: 'How to deploy', body: '# Deploy\n\nUse the workflow.', pinned: true, status: 'active',
  createdAt: '2026-11-19T10:00:00Z', updatedAt: '2026-11-19T10:00:00Z', updatedBy: 'user', verifiedAt: null, readCount: 2, lastReadAt: null, sha: 'abc',
};
const summary: MemoryPageSummary = (({ body: _b, ...rest }) => ({ ...rest, bytes: 30 }))(page);
const note: MemoryNote = { id: 7, scope: 'project:p1', text: 'Tests need FOO=1.', aboutSlug: null, origin: 'thread', terminalId: 't1', harness: 'codex', askedByUser: false, externalContext: false, sourceRef: null, createdAt: '2026-11-19T11:00:00Z', status: 'new' };
let settings: MemorySettings;

beforeEach(() => {
  settings = { enabled: true, paused: false, blockChars: 4000, projectsOff: [], available: true };
  useMemory.setState({ scopes: null, settings: null, scope: 'project:p1', pages: null, notes: null, block: null, error: null });
  vi.spyOn(api, 'memoryScopes').mockResolvedValue({ scopes: [
    { scope: 'you', label: 'You', projectId: null, pages: 0, newNotes: 0, remembered: true, archived: false },
    { scope: 'project:p1', label: 'web-app', projectId: 'p1', pages: 1, newNotes: 1, remembered: true, archived: false },
  ] });
  vi.spyOn(api, 'memorySettings').mockImplementation(async () => settings);
  vi.spyOn(api, 'memoryUpdateSettings').mockImplementation(async (p) => { settings = { ...settings, ...p }; return settings; });
  vi.spyOn(api, 'memoryPages').mockResolvedValue({ pages: [summary] });
  vi.spyOn(api, 'memoryNotes').mockResolvedValue({ notes: [note] });
  vi.spyOn(api, 'memoryBlock').mockResolvedValue({ text: '## Memory\n\nYou have a memory…', chars: 1234, cap: 4000 });
  vi.spyOn(api, 'memoryPage').mockResolvedValue({ page, notes: [] });
  vi.spyOn(api, 'memoryAddNote').mockResolvedValue({ ...note, id: 8, origin: 'user', text: 'by hand' });
  vi.spyOn(api, 'memoryDeleteNote').mockResolvedValue({ ok: true });
  vi.spyOn(api, 'memoryUpdatePage').mockResolvedValue({ ...page, body: 'new text', sha: 'def' });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the Memory view (spec 2026-11-17, part 5)', () => {
  it('shows the scopes, what threads see, the pages and the new notes of the scope', async () => {
    render(<MemoryView />);
    const nav = await screen.findByRole('navigation', { name: 'Memory scopes' });
    expect(within(nav).getByText('You')).toBeTruthy();
    expect(within(nav).getByRole('button', { name: /web-app/ }).getAttribute('aria-current')).toBe('page');
    expect(await screen.findByText(/What threads see \(1,234 of 4,000 characters\)/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'deploy: open' })).toBeTruthy();
    expect(screen.getByText('Tests need FOO=1.')).toBeTruthy();
    expect(api.memoryBlock).toHaveBeenCalledWith('p1');
  });

  it('adds and deletes a note; pauses memory; turns the project off', async () => {
    render(<MemoryView />);
    fireEvent.change(await screen.findByRole('textbox', { name: 'New note' }), { target: { value: 'by hand' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.memoryAddNote).toHaveBeenCalledWith({ scope: 'project:p1', text: 'by hand' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete note 7' }));
    await waitFor(() => expect(api.memoryDeleteNote).toHaveBeenCalledWith(7));
    fireEvent.click(screen.getByRole('switch', { name: 'Pause' }));
    await waitFor(() => expect(api.memoryUpdateSettings).toHaveBeenCalledWith({ paused: true }));
    fireEvent.click(screen.getByRole('switch', { name: 'Remember this project' }));
    await waitFor(() => expect(api.memoryUpdateSettings).toHaveBeenCalledWith({ projectsOff: ['p1'] }));
  });

  it('off (the default): one row with its switch and one sentence; the switch turns memory on', async () => {
    settings = { ...settings, enabled: false, available: false };
    render(<MemoryView />);
    expect(await screen.findByText(/When memory is on, threads keep notes between threads/)).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Memory scopes' })).toBeNull();
    expect(screen.queryByText(/What threads see/)).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Memory' }));
    await waitFor(() => expect(api.memoryUpdateSettings).toHaveBeenCalledWith({ enabled: true }));
    expect(await screen.findByRole('navigation', { name: 'Memory scopes' })).toBeTruthy();
  });

  it('Settings > Memory (the phone) is the same: off shows only the switch', async () => {
    settings = { ...settings, enabled: false, available: false };
    render(<MemorySection />);
    expect(await screen.findByRole('switch', { name: 'Memory' })).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'Pause' })).toBeNull();
  });

  it('opens a page and saves an edit with the sha it started from', async () => {
    render(<MemoryView />);
    fireEvent.click(await screen.findByRole('button', { name: 'deploy: open' }));
    expect(await screen.findByTestId('memory-page-body')).toHaveTextContent('Use the workflow.');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Page text' }), { target: { value: 'new text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.memoryUpdatePage).toHaveBeenCalledWith(1, { description: 'How to deploy', body: 'new text', expectedSha: 'abc' }));
  });
});
