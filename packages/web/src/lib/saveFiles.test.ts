import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { saveFilesAs } from './saveFiles';

function fakeWritable() {
  return { write: vi.fn(async () => {}), close: vi.fn(async () => {}) };
}

describe('saveFilesAs', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { pipeTo: vi.fn(async () => {}) },
    })));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('writes every file into the ONE folder the user picked', async () => {
    const writable = fakeWritable();
    const getFileHandle = vi.fn(async () => ({ createWritable: async () => writable }));
    const showDirectoryPicker = vi.fn(async () => ({ getFileHandle }));
    vi.stubGlobal('showDirectoryPicker', showDirectoryPicker);

    await saveFilesAs([
      { url: '/dl?path=a.png', name: 'a.png' },
      { url: '/dl?path=b.pdf', name: 'b.pdf' },
    ]);

    expect(showDirectoryPicker).toHaveBeenCalledTimes(1); // one dialog, not N
    expect(getFileHandle).toHaveBeenCalledWith('a.png', { create: true });
    expect(getFileHandle).toHaveBeenCalledWith('b.pdf', { create: true });
  });

  it('does nothing when the user cancels the folder dialog', async () => {
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    vi.stubGlobal('showDirectoryPicker', vi.fn(async () => { throw abort; }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await saveFilesAs([{ url: '/dl?path=a.png', name: 'a.png' }, { url: '/dl?path=b.pdf', name: 'b.pdf' }]);

    // Cancelling means "I changed my mind" — it must never fall through to the anchor-download
    // fallback. Asserting `fetch` alone would not catch that leak, since the fallback never
    // calls `fetch` at all — it drives <a>.click() directly.
    expect(fetch).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it('attempts every file even after one fails, and reports the failure by name', async () => {
    const writable = fakeWritable();
    const getFileHandle = vi.fn(async () => ({ createWritable: async () => writable }));
    const showDirectoryPicker = vi.fn(async () => ({ getFileHandle }));
    vi.stubGlobal('showDirectoryPicker', showDirectoryPicker);
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/dl?path=b.pdf') return { ok: false, status: 500 };
      return { ok: true, body: { pipeTo: vi.fn(async () => {}) } };
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(saveFilesAs([
      { url: '/dl?path=a.png', name: 'a.png' },
      { url: '/dl?path=b.pdf', name: 'b.pdf' },
      { url: '/dl?path=c.zip', name: 'c.zip' },
    ])).rejects.toThrow('Saved 2 of 3. Failed: b.pdf');

    // All three were attempted — the loop didn't abort when b.pdf failed.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The two good files were actually written.
    expect(getFileHandle).toHaveBeenCalledWith('a.png', { create: true });
    expect(getFileHandle).toHaveBeenCalledWith('c.zip', { create: true });
    expect(getFileHandle).not.toHaveBeenCalledWith('b.pdf', { create: true });
  });

  it('falls back to one download per file when there is no picker (Safari/iOS)', async () => {
    vi.stubGlobal('showDirectoryPicker', undefined);
    vi.stubGlobal('showSaveFilePicker', undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await saveFilesAs([
      { url: '/dl?path=a.png', name: 'a.png' },
      { url: '/dl?path=b.pdf', name: 'b.pdf' },
    ]);

    expect(click).toHaveBeenCalledTimes(2);
  });

  it('routes a lone file through the single-file save picker', async () => {
    const writable = fakeWritable();
    const showSaveFilePicker = vi.fn(async () => ({ createWritable: async () => writable }));
    vi.stubGlobal('showSaveFilePicker', showSaveFilePicker);
    const showDirectoryPicker = vi.fn();
    vi.stubGlobal('showDirectoryPicker', showDirectoryPicker);

    await saveFilesAs([{ url: '/dl?path=a.png', name: 'a.png' }]);

    expect(showSaveFilePicker).toHaveBeenCalledWith({ suggestedName: 'a.png' });
    expect(showDirectoryPicker).not.toHaveBeenCalled();
  });
});
