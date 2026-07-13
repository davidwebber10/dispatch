import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { clipboardImageSupported, copyImageToClipboard } from './clipboard';

class FakeClipboardItem {
  constructor(public items: Record<string, Blob>) {}
}

describe('clipboardImageSupported', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('is false when ClipboardItem is absent', () => {
    vi.stubGlobal('ClipboardItem', undefined);
    expect(clipboardImageSupported()).toBe(false);
  });

  it('is true when clipboard.write and ClipboardItem both exist', () => {
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    vi.stubGlobal('navigator', { clipboard: { write: vi.fn() } });
    expect(clipboardImageSupported()).toBe(true);
  });
});

describe('copyImageToClipboard', () => {
  const write = vi.fn(async () => {});

  beforeEach(() => {
    write.mockClear();
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    vi.stubGlobal('navigator', { clipboard: { write } });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('writes a png blob straight through without re-encoding', async () => {
    const png = new Blob(['fake'], { type: 'image/png' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => png })));

    await copyImageToClipboard('/api/sessions/s1/files/image?path=a.png');

    expect(write).toHaveBeenCalledTimes(1);
    const [[[item]]] = write.mock.calls as unknown as [[[FakeClipboardItem]]];
    expect(item.items['image/png']).toBe(png);
  });

  it('rejects when the clipboard refuses the write', async () => {
    const png = new Blob(['fake'], { type: 'image/png' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => png })));
    write.mockRejectedValueOnce(new Error('NotAllowedError'));

    await expect(copyImageToClipboard('/x.png')).rejects.toThrow('NotAllowedError');
  });
});
