import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, beforeEach, afterEach, it, expect } from 'vitest';
import { ChatImage, ImageViewerHost } from './ChatImage';

/** Open the lightbox and click Download, capturing the anchor the component builds. */
async function downloadFrom(blobType: string, alt: string): Promise<{ download: string }> {
  vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => new Blob(['bytes'], { type: blobType }) })));
  let captured: { download: string } | null = null;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    captured = { download: this.download };
  });

  render(<ChatImage src="/api/sessions/s1/files/image?path=a.avif" alt={alt} />);
  fireEvent.click(screen.getByAltText(alt));                    // thumbnail -> lightbox
  fireEvent.click(screen.getByLabelText('Download image'));

  await waitFor(() => expect(captured).not.toBeNull());
  return captured!;
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:fake');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('names an AVIF download .avif, not .png', async () => {
  // The branch taught the server to SERVE image/avif but not the downloader to NAME it: an
  // unmapped MIME silently falls back to 'png', so the user saved AVIF bytes in a .png file
  // that no viewer would open.
  const { download } = await downloadFrom('image/avif', 'chart');
  expect(download).toBe('chart.avif');
});

it('still names the common types correctly', async () => {
  expect((await downloadFrom('image/png', 'shot')).download).toBe('shot.png');
});

it('opens from a focusable button with an accessible name', () => {
  render(<ChatImage src="/a.png" alt="chart" />);
  const opener = screen.getByRole('button', { name: 'Open image: chart' });
  expect(opener.tagName).toBe('BUTTON'); // a native button opens on Enter and Space
  expect(opener).not.toHaveAttribute('tabindex', '-1');
  opener.focus();
  expect(document.activeElement).toBe(opener);
  fireEvent.click(opener);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

it('opens as a modal dialog, takes focus, traps Tab, and gives focus back on Escape', () => {
  render(<ChatImage src="/a.png" alt="chart" />);
  const opener = screen.getByRole('button', { name: 'Open image: chart' });
  opener.focus();
  fireEvent.click(opener);
  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  const close = screen.getByLabelText('Close');
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(document.activeElement).toBe(close);
  // Tab on the last control wraps to the first; Shift+Tab on the first wraps to the last.
  expect(fireEvent.keyDown(close, { key: 'Tab' })).toBe(false);
  expect(document.activeElement).toBe(screen.getByLabelText('Copy image').hasAttribute('disabled') ? screen.getByLabelText('Download image') : screen.getByLabelText('Copy image'));
  const first = document.activeElement as HTMLElement;
  expect(fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })).toBe(false);
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(opener);
});

it('keeps the viewer open when the image that opened it is replaced by another with the same picture', () => {
  // A sent image row is first drawn from the pending send, then from the logged message: the
  // thumbnail that opened the viewer is unmounted and a new one mounts.
  const { rerender } = render(<ImageViewerHost><ChatImage key="pending" src="data:image/png;base64,AAA" /></ImageViewerHost>);
  fireEvent.click(screen.getByRole('button', { name: 'Open image' }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  rerender(<ImageViewerHost><ChatImage key="logged" src="/api/endless/media/a.png" /></ImageViewerHost>);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('Close'));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('keeps Tab inside the dialog after a click on the image took the focus away', () => {
  render(<ChatImage src="/a.png" alt="chart" />);
  fireEvent.click(screen.getByRole('button', { name: 'Open image: chart' }));
  const dialog = screen.getByRole('dialog');
  // A click on the picture moves focus to the body, where the dialog's own key handler never sees Tab.
  (document.activeElement as HTMLElement).blur();
  expect(dialog.contains(document.activeElement)).toBe(false);
  expect(fireEvent.keyDown(document.body, { key: 'Tab' })).toBe(false);
  expect(dialog.contains(document.activeElement)).toBe(true);
});

it('gives focus to the composer when the thumbnail that opened the viewer was replaced', () => {
  const tree = (k: string) => <ImageViewerHost><textarea aria-label="Message" /><ChatImage key={k} src="/a.png" alt="chart" /></ImageViewerHost>;
  const { rerender } = render(tree('pending'));
  const opener = screen.getByRole('button', { name: 'Open image: chart' });
  opener.focus();
  fireEvent.click(opener);
  rerender(tree('logged')); // the row is replaced at turn end
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message' }));
});

it('a web-address image is a "Load image" control until clicked, and requests nothing before', () => {
  const { container } = render(<ChatImage src="https://img.example.com/a.png?d=1" alt="chart" />);
  expect(container.querySelector('img')).toBeNull();
  const btn = screen.getByRole('button', { name: /Load image from img\.example\.com/ });
  fireEvent.click(btn);
  expect(container.querySelector('img')!.getAttribute('src')).toBe('https://img.example.com/a.png?d=1');
  expect(screen.queryByRole('button', { name: /Load image/ })).toBeNull();
});

it('data:, blob: and same-origin images load at once', () => {
  const own = `${window.location.origin}/x.png`;
  for (const src of ['data:image/png;base64,AAAA', 'blob:http://localhost/abc', '/api/sessions/s1/files/image?path=a.png', own]) {
    const { container, unmount } = render(<ChatImage src={src} alt="a" />);
    expect(container.querySelector('img')).not.toBeNull();
    unmount();
  }
});

it('a click approves that address only: a changed src asks again', () => {
  const { container, rerender } = render(<ChatImage src="https://a.example.com/1.png" alt="x" />);
  fireEvent.click(screen.getByRole('button', { name: /Load image/ }));
  expect(container.querySelector('img')).not.toBeNull();
  rerender(<ChatImage src="https://b.example.com/2.png" alt="x" />);
  expect(container.querySelector('img')).toBeNull();
  expect(screen.getByRole('button', { name: /Load image from b\.example\.com/ })).toBeInTheDocument();
});
