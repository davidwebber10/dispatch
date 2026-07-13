import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, beforeEach, afterEach, test, it, expect } from 'vitest';
import { FilesPane } from './FilesPane';
import { api } from '../../api/client';
import { useHost } from '../../stores/host';
import { useProjects } from '../../stores/projects';
import { saveFilesAs } from '../../lib/saveFiles';
import { copyImageToClipboard } from '../../lib/clipboard';

// Keep the REAL saveFilesAs by default (the "Save As…" test below exercises the genuine
// anchor-download fallback), but wrap it in a vi.fn so individual tests can assert on the
// exact selection it was handed, or force a rejection to prove failures surface to the user.
vi.mock('../../lib/saveFiles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/saveFiles')>();
  return { ...actual, saveFilesAs: vi.fn(actual.saveFilesAs) };
});

vi.mock('../../lib/clipboard', () => ({
  copyImageToClipboard: vi.fn(async () => {}),
  clipboardImageSupported: () => true,
}));

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
  // Fresh per test: fail closed on Reveal, and give project 'p1' a real workingDir so the
  // Copy Paths assertion has an absolute prefix to check.
  useHost.setState({ platform: 'darwin', canReveal: false });
  useProjects.setState({
    sessions: [{ id: 'p1', name: 'p1', workingDir: '/work', status: 'working' } as any],
    activeId: 'p1',
  });
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
  // `targets` already falls back to [menu.entry.path] whenever the right-clicked row isn't
  // in `selected`, regardless of whether onRowContext ever mutated selection state. So a
  // single right-click-and-assert can't distinguish "the collapse happened" from "the collapse
  // branch doesn't exist at all". To actually observe the collapsed SELECTION STATE (not just
  // the label on the same right-click), we collapse onto c, dismiss the menu, then right-click
  // a — which was selected before the collapse. If selection is still {a, b} at that point (no
  // collapse), the menu shows "Delete 2 items"; if it collapsed to {c}, a is no longer selected
  // and the menu shows singular "Delete".
  render(<FilesPane projectId="p1" onOpenFile={() => {}} />);
  const a = await screen.findByText('a.png');
  const b = await screen.findByText('b.png');
  const c = await screen.findByText('c.txt');

  fireEvent.click(a);                                  // selection: {a}
  fireEvent.click(b, { metaKey: true });                // selection: {a, b}
  fireEvent.contextMenu(c);                             // c is NOT selected -> collapse to {c}
  fireEvent.keyDown(window, { key: 'Escape' });          // dismiss the menu

  fireEvent.contextMenu(a);                             // a was selected pre-collapse

  expect(screen.getByText('Delete')).toBeInTheDocument();       // singular — just a
  expect(screen.queryByText(/Delete \d+ items/)).toBeNull();
});

it('offers Copy Image for a lone image, and hides it for anything else', async () => {
  render(<FilesPane projectId="p1" onOpenFile={() => {}} />);
  const a = await screen.findByText('a.png');
  const c = await screen.findByText('c.txt');

  fireEvent.contextMenu(a);
  expect(screen.getByText('Copy Image')).toBeInTheDocument();
  fireEvent.keyDown(window, { key: 'Escape' });

  fireEvent.contextMenu(c);                                  // a .txt is not an image
  expect(screen.queryByText('Copy Image')).toBeNull();
  fireEvent.keyDown(window, { key: 'Escape' });

  fireEvent.click(a);                                        // two images selected — still no
  fireEvent.click(await screen.findByText('b.png'), { metaKey: true });
  fireEvent.contextMenu(a);
  expect(screen.queryByText('Copy Image')).toBeNull();       // ClipboardItem can't hold two
});

it('copies the absolute paths of the whole selection as text', async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  render(<FilesPane projectId="p1" onOpenFile={() => {}} />);

  fireEvent.click(await screen.findByText('a.png'));
  fireEvent.click(await screen.findByText('c.txt'), { metaKey: true });
  fireEvent.contextMenu(await screen.findByText('c.txt'));
  fireEvent.click(screen.getByText('Copy 2 Paths'));

  await waitFor(() => expect(writeText).toHaveBeenCalledWith('/work/a.png\n/work/c.txt'));
  vi.unstubAllGlobals();
});

it('hides Reveal in Finder when the daemon is remote', async () => {
  useHost.setState({ platform: 'darwin', canReveal: false });
  render(<FilesPane projectId="p1" onOpenFile={() => {}} />);
  fireEvent.contextMenu(await screen.findByText('a.png'));
  expect(screen.queryByText('Reveal in Finder')).toBeNull();
});

it('reveals the whole selection when the daemon is local', async () => {
  useHost.setState({ platform: 'darwin', canReveal: true });
  const reveal = vi.spyOn(api, 'revealFiles').mockResolvedValue({ ok: true } as never);
  render(<FilesPane projectId="p1" onOpenFile={() => {}} />);

  fireEvent.click(await screen.findByText('a.png'));
  fireEvent.click(await screen.findByText('b.png'), { metaKey: true });
  fireEvent.contextMenu(await screen.findByText('b.png'));
  fireEvent.click(screen.getByText('Reveal in Finder'));

  await waitFor(() => expect(reveal).toHaveBeenCalledWith('p1', ['a.png', 'b.png']));
});

it('hides Rename for a multi-selection', async () => {
  render(<FilesPane projectId="p1" onOpenFile={() => {}} />);
  fireEvent.click(await screen.findByText('a.png'));
  fireEvent.click(await screen.findByText('b.png'), { metaKey: true });
  fireEvent.contextMenu(await screen.findByText('b.png'));
  expect(screen.queryByText('Rename')).toBeNull();
});

it('deletes every selected file after one confirmation', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const del = vi.spyOn(api, 'deleteFile').mockResolvedValue({ ok: true } as never);
  render(<FilesPane projectId="p1" onOpenFile={() => {}} />);

  fireEvent.click(await screen.findByText('a.png'));
  fireEvent.click(await screen.findByText('b.png'), { metaKey: true });
  fireEvent.contextMenu(await screen.findByText('b.png'));
  fireEvent.click(screen.getByText('Delete 2 items'));

  await waitFor(() => expect(del).toHaveBeenCalledTimes(2));
  expect(window.confirm).toHaveBeenCalledTimes(1);      // one prompt, not two
});

it('Copy Image copies exactly the lone selected image, not some other file', async () => {
  render(<FilesPane projectId="p1" onOpenFile={() => {}} />);

  fireEvent.contextMenu(await screen.findByText('a.png'));
  fireEvent.click(await screen.findByText('Copy Image'));

  // Assert the exact URL, not just "was called" — a regression that passed the wrong path
  // (e.g. menu.entry.path instead of loneImage) or the wrong project id would still satisfy
  // a bare toHaveBeenCalled() but would copy the wrong picture into the user's clipboard.
  await waitFor(() =>
    expect(copyImageToClipboard).toHaveBeenCalledWith(api.imageUrl('p1', 'a.png')),
  );
});

it('Save As on a multi-selection hands saveFilesAs the whole selection with the right URLs and names', async () => {
  vi.mocked(saveFilesAs).mockResolvedValueOnce(undefined); // skip the real download machinery
  render(<FilesPane projectId="p1" onOpenFile={() => {}} />);

  fireEvent.click(await screen.findByText('a.png'));
  fireEvent.click(await screen.findByText('b.png'), { metaKey: true });
  fireEvent.contextMenu(await screen.findByText('b.png'));
  fireEvent.click(screen.getByText('Save 2 Files As…'));

  // A regression that dropped a file from the selection, swapped downloadUrl for some other
  // URL builder, hardcoded the wrong project id, or used the full path instead of the bare
  // name would all still call saveFilesAs "with something" — only an exact deep-equal on the
  // array catches them.
  await waitFor(() =>
    expect(saveFilesAs).toHaveBeenCalledWith([
      { url: api.downloadUrl('p1', 'a.png'), name: 'a.png' },
      { url: api.downloadUrl('p1', 'b.png'), name: 'b.png' },
    ]),
  );
});

it('surfaces a partial Save As failure via alert instead of swallowing it', async () => {
  vi.mocked(saveFilesAs).mockRejectedValueOnce(new Error('Saved 1 of 2. Failed: b.png'));
  const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
  render(<FilesPane projectId="p1" onOpenFile={() => {}} />);

  fireEvent.click(await screen.findByText('a.png'));
  fireEvent.click(await screen.findByText('b.png'), { metaKey: true });
  fireEvent.contextMenu(await screen.findByText('b.png'));
  fireEvent.click(screen.getByText('Save 2 Files As…'));

  // If saveTargets's catch block were ever deleted (or its window.alert call dropped), the
  // rejection would be swallowed silently and the user would be left with a half-populated
  // folder and no idea a file was missing. This proves the message actually reaches them.
  await waitFor(() =>
    expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('Saved 1 of 2. Failed: b.png')),
  );
});

it('copyPaths strips a trailing slash from workingDir before joining, avoiding a double slash', async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  useProjects.setState({
    sessions: [{ id: 'p1', name: 'p1', workingDir: '/work/', status: 'working' } as any],
    activeId: 'p1',
  });
  render(<FilesPane projectId="p1" onOpenFile={() => {}} />);

  fireEvent.contextMenu(await screen.findByText('a.png'));
  fireEvent.click(screen.getByText('Copy Path'));

  // Without the trailing-slash strip this would be '/work//a.png' — a double slash — and the
  // assertion would fail.
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('/work/a.png'));
  vi.unstubAllGlobals();
});
