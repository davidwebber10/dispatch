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
