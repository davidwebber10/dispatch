import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { PreviewItem, previewFileKind } from './PreviewItem';
import { api } from '../../api/client';
import type { Preview } from '../../api/types';

const base: Preview = {
  id: 'pv1', sessionId: 's1', sessionName: 'Alpha', terminalId: 't1', terminalLabel: 'Worker A', title: 'The fix', note: 'after the rebuild',
  text: 'npm run build', files: [
    { path: '/a/shot.png', name: 'shot.png', mime: 'image/png', size: 1200 },
    { path: '/a/report.pdf', name: 'report.pdf', mime: 'application/pdf', size: 20000 },
    { path: '/a/notes.md', name: 'notes.md', mime: 'text/markdown', size: 40 },
  ],
  createdAt: new Date().toISOString(), seenAt: null,
};

beforeEach(() => { Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } }); });
afterEach(() => { vi.restoreAllMocks(); });

describe('<PreviewItem>', () => {
  it('shows the title, context, note, the text with Copy, and a chip per file', async () => {
    render(<PreviewItem preview={base} />);
    expect(screen.getByText('The fix')).toBeInTheDocument();
    expect(screen.getByText('Alpha · Worker A')).toBeInTheDocument();
    expect(screen.getByTestId('preview-when').textContent).toMatch(/^Today \d/);
    expect(screen.getByLabelText('New')).toBeInTheDocument(); // not viewed yet
    expect(screen.getByText('after the rebuild')).toBeInTheDocument();
    expect(screen.getByTestId('preview-text')).toHaveTextContent('npm run build');
    fireEvent.click(screen.getByRole('button', { name: 'Copy text' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('npm run build'));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /shot\.png/ })).toBeInTheDocument();
    expect(screen.getByTestId('preview-item')).toHaveAttribute('data-unseen', 'true');
  });

  it('any file opens the viewer on all files at that one: the image, the pdf in a frame with Open, the markdown rendered with Copy', async () => {
    vi.spyOn(api, 'previewFileText').mockResolvedValue('# hello');
    render(<PreviewItem preview={base} />);
    fireEvent.click(screen.getByRole('button', { name: /shot\.png/ }));
    expect(await screen.findByRole('dialog', { name: 'shot.png' })).toBeInTheDocument();
    expect(screen.getByLabelText('File 1 of 3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /report\.pdf/ }));
    expect(await screen.findByRole('dialog', { name: 'report.pdf' })).toBeInTheDocument();
    expect(document.querySelector('iframe[title="report.pdf"]')).not.toBeNull();
    expect(screen.getByLabelText('Open in a new tab')).toHaveAttribute('href', expect.stringContaining('/api/previews/pv1/files/1'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: /notes\.md/ }));
    const reader = await screen.findByRole('dialog', { name: 'notes.md' });
    expect(await screen.findByText('hello')).toBeInTheDocument();
    expect(within(reader).getByLabelText('Copy text')).toBeInTheDocument();
  });

  it('Delete calls back with the id; without a handler there is no button', () => {
    const onDelete = vi.fn();
    const { unmount } = render(<PreviewItem preview={base} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete preview' }));
    expect(onDelete).toHaveBeenCalledWith('pv1');
    unmount();
    render(<PreviewItem preview={base} />);
    expect(screen.queryByRole('button', { name: 'Delete preview' })).toBeNull();
  });

  it('previewFileKind sorts the types', () => {
    expect(previewFileKind({ mime: 'image/webp' })).toBe('image');
    expect(previewFileKind({ mime: 'application/pdf' })).toBe('pdf');
    expect(previewFileKind({ mime: 'text/html' })).toBe('html');
    expect(previewFileKind({ mime: 'text/markdown' })).toBe('markdown');
    expect(previewFileKind({ mime: 'application/json' })).toBe('text');
  });

  it('shows images as pictures to tap, and other files as chips', () => {
    render(<PreviewItem preview={base} />);
    const thumbs = screen.getByTestId('preview-thumbs');
    const img = thumbs.querySelector('img')!;
    expect(img.getAttribute('src')).toContain('/api/previews/pv1/files/0');
    expect(screen.getByRole('button', { name: 'Open shot.png' })).toBeInTheDocument();
    expect(thumbs.textContent).not.toContain('report.pdf');
    expect(screen.getByRole('button', { name: /report\.pdf/ })).toBeInTheDocument();
  });
});

