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

    await saveFilesAs([{ url: '/dl?path=a.png', name: 'a.png' }, { url: '/dl?path=b.pdf', name: 'b.pdf' }]);

    expect(fetch).not.toHaveBeenCalled();
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
