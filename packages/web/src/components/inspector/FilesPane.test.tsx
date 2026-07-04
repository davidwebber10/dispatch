import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, beforeEach, afterEach, test, expect } from 'vitest';
import { FilesPane } from './FilesPane';
import { api } from '../../api/client';

beforeEach(() => {
  vi.spyOn(api, 'listFiles').mockResolvedValue([
    { name: 'README.md', isDirectory: false, path: 'README.md' },
    { name: 'src', isDirectory: true, path: 'src' },
  ]);
});
afterEach(() => vi.restoreAllMocks());

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
