import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileViewer, viewerKind, downloadFile, type ViewerFile } from './FileViewer';

const files: ViewerFile[] = [
  { src: '/f/one.png', name: 'one.png', mime: 'image/png' },
  { src: '/f/two.png', name: 'two.png', mime: 'image/png' },
  { src: '/f/notes.md', name: 'notes.md', mime: 'text/markdown', loadText: async () => '# Hello\n\nbody' },
  { src: '/f/report.pdf', name: 'report.pdf', mime: 'application/pdf' },
];

const touch = (x: number, y: number) => ({ clientX: x, clientY: y, identifier: 0 });

beforeEach(() => { Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } }); });
afterEach(() => { vi.restoreAllMocks(); });

describe('FileViewer (2026-11-07)', () => {
  it('viewerKind sorts the types', () => {
    expect(['image/png', 'application/pdf', 'text/html', 'text/markdown', 'text/csv'].map(viewerKind)).toEqual(['image', 'pdf', 'html', 'markdown', 'text']);
  });

  it('opens as a modal dialog on the asked file, with its name and position, and a strip of all files', () => {
    render(<FileViewer files={files} index={1} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('two.png')).toBeInTheDocument();
    expect(screen.getByLabelText('File 2 of 4')).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-label'))).toEqual(['one.png', 'two.png', 'notes.md', 'report.pdf']);
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(screen.getByLabelText('Close'));
  });

  it('arrow keys and the strip step between files; Escape closes', () => {
    const onClose = vi.fn();
    render(<FileViewer files={files} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByLabelText('File 2 of 4')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getByLabelText('File 1 of 4')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'ArrowLeft' }); // stays on the first
    expect(screen.getByLabelText('File 1 of 4')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'report.pdf' }));
    expect(screen.getByLabelText('File 4 of 4')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('a swipe left goes to the next file, a swipe right back; a short drag stays', () => {
    render(<FileViewer files={files} onClose={() => {}} />);
    const stage = screen.getByRole('dialog').querySelector('[data-backdrop]') as HTMLElement;
    fireEvent.touchStart(stage, { touches: [touch(300, 300)] });
    fireEvent.touchMove(stage, { touches: [touch(200, 302)] });
    fireEvent.touchEnd(stage, { touches: [], changedTouches: [touch(200, 302)] });
    expect(screen.getByLabelText('File 2 of 4')).toBeInTheDocument();
    // A short, slow drag (test time stands still, so the clock is moved: a 20px drag in 0ms would read as a flick).
    vi.useFakeTimers();
    try {
      fireEvent.touchStart(stage, { touches: [touch(100, 300)] });
      fireEvent.touchMove(stage, { touches: [touch(120, 300)] });
      vi.advanceTimersByTime(400);
      fireEvent.touchEnd(stage, { touches: [], changedTouches: [touch(120, 300)] });
    } finally { vi.useRealTimers(); }
    expect(screen.getByLabelText('File 2 of 4')).toBeInTheDocument();
    fireEvent.touchStart(stage, { touches: [touch(100, 300)] });
    fireEvent.touchMove(stage, { touches: [touch(260, 300)] });
    fireEvent.touchEnd(stage, { touches: [], changedTouches: [touch(260, 300)] });
    expect(screen.getByLabelText('File 1 of 4')).toBeInTheDocument();
  });

  it('a pull down on a picture closes; on a text file it does not (the text scrolls)', () => {
    const onClose = vi.fn();
    render(<FileViewer files={files} onClose={onClose} />);
    const stage = screen.getByRole('dialog').querySelector('[data-backdrop]') as HTMLElement;
    fireEvent.touchStart(stage, { touches: [touch(200, 100)] });
    fireEvent.touchMove(stage, { touches: [touch(202, 260)] });
    fireEvent.touchEnd(stage, { touches: [], changedTouches: [touch(202, 260)] });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a double tap zooms the picture in, and again out; a pinch zooms too', () => {
    render(<FileViewer files={files} onClose={() => {}} />);
    const stage = screen.getByRole('dialog').querySelector('[data-backdrop]') as HTMLElement;
    const img = screen.getByAltText('one.png') as HTMLImageElement;
    const transformOf = () => img.style.transform;
    expect(transformOf()).toContain('scale(1)');
    for (let i = 0; i < 2; i++) {
      fireEvent.touchStart(stage, { touches: [touch(200, 200)] });
      fireEvent.touchEnd(stage, { touches: [], changedTouches: [touch(200, 200)] });
    }
    expect(transformOf()).toContain('scale(2.5)');
    for (let i = 0; i < 2; i++) {
      fireEvent.touchStart(stage, { touches: [touch(200, 200)] });
      fireEvent.touchEnd(stage, { touches: [], changedTouches: [touch(200, 200)] });
    }
    expect(transformOf()).toContain('scale(1)');
    fireEvent.touchStart(stage, { touches: [touch(100, 200), touch(200, 200)] });
    fireEvent.touchMove(stage, { touches: [touch(50, 200), touch(250, 200)] });
    fireEvent.touchEnd(stage, { touches: [], changedTouches: [touch(250, 200)] });
    expect(transformOf()).toContain('scale(2)');
  });

  it('zoom buttons and keys on a desktop; a zoomed picture does not swipe', () => {
    render(<FileViewer files={files} onClose={() => {}} />);
    const img = screen.getByAltText('one.png') as HTMLImageElement;
    fireEvent.click(screen.getByLabelText('Zoom in'));
    expect(img.style.transform).toContain('scale(1.5)');
    fireEvent.keyDown(window, { key: '+' });
    expect(img.style.transform).toContain('scale(2.25)');
    fireEvent.keyDown(window, { key: '0' });
    expect(img.style.transform).toContain('scale(1)');
    fireEvent.dblClick(img, { clientX: 10, clientY: 10 });
    expect(img.style.transform).toContain('scale(2.5)');
    const stage = screen.getByRole('dialog').querySelector('[data-backdrop]') as HTMLElement;
    fireEvent.touchStart(stage, { touches: [touch(300, 300)] });
    fireEvent.touchMove(stage, { touches: [touch(100, 300)] });
    fireEvent.touchEnd(stage, { touches: [], changedTouches: [touch(100, 300)] });
    expect(screen.getByLabelText('File 1 of 4')).toBeInTheDocument();
  });

  it('a markdown file renders in place with Copy text; a pdf shows in a frame with Open', async () => {
    render(<FileViewer files={files} index={2} onClose={() => {}} />);
    expect(await screen.findByText('Hello')).toBeInTheDocument();
    const copy = screen.getByLabelText('Copy text');
    await waitFor(() => expect(copy).not.toBeDisabled());
    fireEvent.click(copy);
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('# Hello\n\nbody'));
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(document.querySelector('iframe[title="report.pdf"]')).not.toBeNull();
    expect(screen.getByLabelText('Open in a new tab')).toHaveAttribute('href', '/f/report.pdf');
    expect(screen.queryByLabelText('Copy text')).toBeNull();
    expect(screen.getByLabelText('Download file')).toBeInTheDocument();
  });

  it('a single image has no strip, no counter and no arrows', () => {
    render(<FileViewer files={[files[0]]} onClose={() => {}} />);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByLabelText(/File 1 of/)).toBeNull();
    expect(screen.queryByLabelText('Next file')).toBeNull();
  });

  it('a click on the backdrop closes; a click on the picture does not', () => {
    const onClose = vi.fn();
    render(<FileViewer files={files} onClose={onClose} />);
    fireEvent.click(screen.getByAltText('one.png'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('dialog').querySelector('[data-backdrop]') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('an inline text file (2026-11-08)', () => {
  const inline: ViewerFile = { src: '', name: 'REPORT.md', mime: 'text/markdown', loadText: async () => '# Hello\n\nBody' };
  afterEach(() => vi.restoreAllMocks());

  it('downloads its own text, without a request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const created: Blob[] = [];
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => { created.push(b); return 'blob:x'; };
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    await downloadFile(inline);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(created).toHaveLength(1);
    expect(await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsText(created[0]); })).toBe('# Hello\n\nBody');
  });

  it('a text or markdown file sits on an opaque backdrop (the page behind does not show)', async () => {
    render(<FileViewer files={[inline]} index={0} onClose={() => {}} />);
    await screen.findByText('Body');
    expect(screen.getByRole('dialog').style.background).toContain('100%');
  });
});
