import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { clipboardImageSupported, copyImageToClipboard, copyText, loadImageBlob } from './clipboard';

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

describe('copyText', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('uses the async Clipboard API when the page is a secure context', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const exec = vi.fn(() => true);
    (document as any).execCommand = exec;

    await copyText('/work/a.png');

    expect(writeText).toHaveBeenCalledWith('/work/a.png');
    expect(exec).not.toHaveBeenCalled();   // no need for the legacy path
  });

  it('still copies over plain http, where navigator.clipboard does not exist', async () => {
    // Dispatch's documented remote access is http://<host>.ts.net:3456 — an INSECURE context,
    // so navigator.clipboard is undefined. Copy Path must still work there.
    vi.stubGlobal('navigator', {});
    let copied: string | null = null;
    const exec = vi.fn(() => {
      copied = (document.activeElement as HTMLTextAreaElement | null)?.value ?? null;
      return true;
    });
    (document as any).execCommand = exec;

    await copyText('/work/a.png\n/work/c.txt');

    expect(exec).toHaveBeenCalledWith('copy');
    expect(copied).toBe('/work/a.png\n/work/c.txt');
    // The scratch textarea must not be left behind in the DOM.
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('falls back to execCommand when the Clipboard API rejects (e.g. permission denied)', async () => {
    const writeText = vi.fn(async () => { throw new Error('NotAllowedError'); });
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const exec = vi.fn(() => true);
    (document as any).execCommand = exec;

    await copyText('hello');

    expect(writeText).toHaveBeenCalled();
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('throws when the legacy path also fails, so the caller can tell the user', async () => {
    vi.stubGlobal('navigator', {});
    (document as any).execCommand = vi.fn(() => false);   // browser refused the copy
    await expect(copyText('hello')).rejects.toThrow();
    expect(document.querySelector('textarea')).toBeNull(); // still cleans up
  });
});

const readText = (b: Blob) => new Promise<string>((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result)); fr.readAsText(b); });

describe('loadImageBlob (the page policy allows connections to the app only)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('decodes a base64 data: URI without calling fetch', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('connect-src blocked'); });
    vi.stubGlobal('fetch', fetchSpy);
    const blob = await loadImageBlob('data:image/png;base64,aGVsbG8=');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(blob.type).toBe('image/png');
    expect(await readText(blob)).toBe('hello');
  });

  it('decodes a plain (percent-encoded) data: URI without calling fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const blob = await loadImageBlob('data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await readText(blob)).toBe('<svg></svg>');
  });

  it('still fetches a same-origin byte route', async () => {
    const png = new Blob(['x'], { type: 'image/png' });
    const fetchSpy = vi.fn(async () => ({ blob: async () => png }));
    vi.stubGlobal('fetch', fetchSpy);
    expect(await loadImageBlob('/api/sessions/s1/files/image?path=a.png')).toBe(png);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('copying a data: URI image reaches the clipboard with no fetch', async () => {
    const write = vi.fn(async () => {});
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    vi.stubGlobal('navigator', { clipboard: { write } });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect-src blocked'); }));
    await copyImageToClipboard('data:image/png;base64,aGVsbG8=');
    expect(write).toHaveBeenCalledTimes(1);
  });
});
