import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, beforeEach, afterEach, test, expect } from 'vitest';
import { FilesPane } from './FilesPane';
import { api } from '../../api/client';

beforeEach(() => {
  // '.' includes the original README.md/src fixture (existing tests depend on those names)
  // plus three plain files (a.png, b.png, c.txt) so the multi-select range tests have
  // contiguous, unambiguously-ordered file rows to span.
  vi.spyOn(api, 'listFiles').mockImplementation(async (_projectId: string, path = '.') => {
    if (path === '.') {
      return [
        { name: 'README.md', isDirectory: false, path: 'README.md' },
        { name: 'src', isDirectory: true, path: 'src' },
        { name: 'a.png', isDirectory: false, path: 'a.png' },
        { name: 'b.png', isDirectory: false, path: 'b.png' },
        { name: 'c.txt', isDirectory: false, path: 'c.txt' },
      ];
    }
    return [];
  });
  // A plain click both selects AND opens (existing behavior) — the multi-select tests below all
  // start with a plain click to establish the anchor, which exercises the open path even though
  // the test itself is only asserting on selection. Stub it out so that path resolves instead of
  // hitting a real (jsdom-unsupported) fetch and blowing up as an unhandled rejection.
  vi.spyOn(api, 'createTerminal').mockResolvedValue({
    id: 't1', sessionId: 'p1', type: 'file', label: 'x', pid: null, externalId: null,
    workingDir: null, status: 'idle', createdAt: '', config: {}, archivedAt: null, sortOrder: 0,
  } as any);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
});

test('lists directory entries for the project, folders first', async () => {
  render(<FilesPane projectId="s1" onOpenFile={() => {}} />);
  expect(await screen.findByText(/src/)).toBeInTheDocument();
  expect(screen.getByText(/README\.md/)).toBeInTheDocument();
  expect(api.listFiles).toHaveBeenCalledWith('s1', '.');
});

test('right-click a file → Save As… downloads it via the download URL', async () => {
  // jsdom has no File System Access API, so saveFileAs takes the anchor-download fallback.
  let captured: { href: string; download: string } | null = null;
  const clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function (this: HTMLAnchorElement) {
      captured = { href: this.href, download: this.download };
    });

  render(<FilesPane projectId="s1" onOpenFile={() => {}} />);
  const fileRow = await screen.findByText(/README\.md/);

  // No menu until you right-click.
  expect(screen.queryByText(/Save As/)).toBeNull();
  fireEvent.contextMenu(fileRow, { clientX: 10, clientY: 20 });

  const saveAs = await screen.findByText(/Save As/);
  fireEvent.click(saveAs);

  await waitFor(() => expect(clickSpy).toHaveBeenCalled());
  expect(captured!.href).toContain('/api/sessions/s1/files/download?path=README.md');
  expect(captured!.download).toBe('README.md');
});

test('right-click → Rename calls renameFile with the new path', async () => {
  const rename = vi.spyOn(api, 'renameFile').mockResolvedValue({ ok: true, path: 'NOTES.md' });
  vi.spyOn(window, 'prompt').mockReturnValue('NOTES.md');

  render(<FilesPane projectId="s1" onOpenFile={() => {}} />);
  fireEvent.contextMenu(await screen.findByText(/README\.md/), { clientX: 5, clientY: 5 });
  fireEvent.click(await screen.findByText('Rename'));

  await waitFor(() => expect(rename).toHaveBeenCalledWith('s1', 'README.md', 'NOTES.md'));
});

test('right-click → Delete calls deleteFile after confirmation', async () => {
  const del = vi.spyOn(api, 'deleteFile').mockResolvedValue({ ok: true });
  vi.spyOn(window, 'confirm').mockReturnValue(true);

  render(<FilesPane projectId="s1" onOpenFile={() => {}} />);
  fireEvent.contextMenu(await screen.findByText(/README\.md/), { clientX: 5, clientY: 5 });
  fireEvent.click(await screen.findByText('Delete'));

  await waitFor(() => expect(del).toHaveBeenCalledWith('s1', 'README.md'));
});

test('Delete does nothing when the confirm is dismissed', async () => {
  const del = vi.spyOn(api, 'deleteFile').mockResolvedValue({ ok: true });
  vi.spyOn(window, 'confirm').mockReturnValue(false);

  render(<FilesPane projectId="s1" onOpenFile={() => {}} />);
  fireEvent.contextMenu(await screen.findByText(/README\.md/), { clientX: 5, clientY: 5 });
  fireEvent.click(await screen.findByText('Delete'));

  expect(del).not.toHaveBeenCalled();
});

test('cmd-click adds to the selection without opening the file', async () => {
  const createTerminal = vi.spyOn(api, 'createTerminal');
  render(<FilesPane projectId="p1" onOpenFile={() => {}} />);
  const a = await screen.findByText('a.png');
  const b = await screen.findByText('b.png');

  fireEvent.click(a);                                  // plain click: selects AND opens
  createTerminal.mockClear();
  fireEvent.click(b, { metaKey: true });               // cmd-click: selects only

  expect(createTerminal).not.toHaveBeenCalled();

  // Both are now targets: right-click one, and Delete should offer to remove 2 items.
  fireEvent.contextMenu(b);
  expect(screen.getByText('Delete 2 items')).toBeInTheDocument();
});

test('shift-click selects the range between the anchor and the clicked row', async () => {
  render(<FilesPane projectId="p1" onOpenFile={() => {}} />);
  const a = await screen.findByText('a.png');
  const c = await screen.findByText('c.txt');

  fireEvent.click(a);
  fireEvent.click(c, { shiftKey: true });

  fireEvent.contextMenu(c);
  expect(screen.getByText('Delete 3 items')).toBeInTheDocument(); // a.png, b.png, c.txt
});

test('right-clicking outside the selection collapses it to that row', async () => {
  render(<FilesPane projectId="p1" onOpenFile={() => {}} />);
  const a = await screen.findByText('a.png');
  const b = await screen.findByText('b.png');
  const c = await screen.findByText('c.txt');

  fireEvent.click(a);
  fireEvent.click(b, { metaKey: true });
  fireEvent.contextMenu(c);                            // c is NOT selected

  expect(screen.getByText('Delete')).toBeInTheDocument();       // singular — just c
  expect(screen.queryByText(/Delete \d+ items/)).toBeNull();
});
