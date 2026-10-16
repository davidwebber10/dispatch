import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, beforeEach, afterEach, it, expect } from 'vitest';
import { ChatImage } from './ChatImage';

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
