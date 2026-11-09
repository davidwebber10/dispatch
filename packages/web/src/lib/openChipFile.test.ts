import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openChipFile } from './openChipFile';
import * as openFileTabMod from './openFileTab';
import * as saveFiles from './saveFiles';
import { api } from '../api/client';
import { useDocViewer } from '../stores/docViewer';
import { useUI } from '../stores/ui';

// The open-thread request is `navigate` since W2-F; these tests check that it is made, not where it lands.
let openThread: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.restoreAllMocks();
  useDocViewer.setState({ open: null, back: [] });
  useUI.setState({ view: 'chat' } as never);
  openThread = vi.spyOn(useUI.getState(), 'requestOpenThread').mockImplementation(() => {});
});

describe('openChipFile', () => {
  it('a doc opens the doc viewer, in the viewer of a view that has an origin', async () => {
    const tab = vi.spyOn(openFileTabMod, 'openFileTab');
    await openChipFile({ project: 's1', path: 'docs/a.md', rel: 'docs/a.md', branch: 'b', nav: 'chat' });
    expect(useDocViewer.getState().open).toEqual({ project: 's1', path: 'docs/a.md', branch: 'b' });
    await openChipFile({ project: 's1', path: 'n.txt', rel: 'n.txt', branch: null, nav: 'threads', origin: 't9' });
    expect(useDocViewer.getState().open).toEqual({ project: 's1', path: 'n.txt', branch: null, origin: 't9' });
    expect(tab).not.toHaveBeenCalled();
  });
  it('a text file opens a file tab; nav threads asks for it to come to front', async () => {
    const tab = vi.spyOn(openFileTabMod, 'openFileTab').mockResolvedValue('ft1');
    await openChipFile({ project: 's1', path: 'scripts/extract.py', rel: 'scripts/extract.py', branch: null, nav: 'threads' });
    expect(tab).toHaveBeenCalledWith('s1', 'scripts/extract.py', { focus: true });
    expect(useDocViewer.getState().open).toBeNull();
  });
  it('nav stay opens the tab and stays put', async () => {
    const tab = vi.spyOn(openFileTabMod, 'openFileTab').mockResolvedValue('ft1');
    await openChipFile({ project: 's1', path: 'a.py', rel: 'a.py', branch: null, nav: 'stay' });
    expect(tab).toHaveBeenCalledWith('s1', 'a.py', { focus: false });
    expect(openThread).not.toHaveBeenCalled();
  });
  it('from Chat, a file tab opens in the Threads view (desktop and phone read the same request)', async () => {
    vi.spyOn(openFileTabMod, 'openFileTab').mockResolvedValue('ft1');
    await openChipFile({ project: 's1', path: 'a.py', rel: 'a.py', branch: null, nav: 'chat' });
    expect(openThread).toHaveBeenCalledWith({ sessionId: 's1', terminalId: 'ft1' });
    expect(useUI.getState().view).toBe('workspace');
  });
  it('from Chat, a tab that could not be made opens nothing', async () => {
    vi.spyOn(openFileTabMod, 'openFileTab').mockResolvedValue(null);
    await openChipFile({ project: 's1', path: 'a.py', rel: 'a.py', branch: null, nav: 'chat' });
    expect(openThread).not.toHaveBeenCalled();
    expect(useUI.getState().view).toBe('chat');
  });
  it('a file tab opens the path inside the project, not the absolute path', async () => {
    const tab = vi.spyOn(openFileTabMod, 'openFileTab').mockResolvedValue('ft1');
    await openChipFile({ project: 's1', path: '/w/app/src/a.py', rel: 'src/a.py', branch: null, nav: 'threads' });
    expect(tab).toHaveBeenCalledWith('s1', 'src/a.py', { focus: true });
  });
  it('a doc keeps the path it was given (the doc route checks it itself)', async () => {
    await openChipFile({ project: 's1', path: '/w/app/docs/a.md', rel: 'docs/a.md', branch: null, nav: 'chat' });
    expect(useDocViewer.getState().open).toMatchObject({ project: 's1', path: '/w/app/docs/a.md' });
  });
  it('an image opens a file tab (the file tab shows images)', async () => {
    const tab = vi.spyOn(openFileTabMod, 'openFileTab').mockResolvedValue('ft1');
    await openChipFile({ project: 's1', path: 'img/shot.png', rel: 'img/shot.png', branch: null, nav: 'threads' });
    expect(tab).toHaveBeenCalledWith('s1', 'img/shot.png', { focus: true });
  });
  it('a binary file with no viewer downloads from the project and opens no tab', async () => {
    const tab = vi.spyOn(openFileTabMod, 'openFileTab');
    const save = vi.spyOn(saveFiles, 'saveFileAs').mockResolvedValue();
    await openChipFile({ project: 's1', path: '/w/app/data/out.xlsx', rel: 'data/out.xlsx', branch: null, nav: 'chat' });
    expect(save).toHaveBeenCalledWith('/api/sessions/s1/files/download?path=data%2Fout.xlsx', 'out.xlsx');
    expect(tab).not.toHaveBeenCalled();
  });
  it('a failed download tells the reader', async () => {
    vi.spyOn(saveFiles, 'saveFileAs').mockRejectedValue(new Error('download failed: 404'));
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    await openChipFile({ project: 's1', path: 'a.parquet', rel: 'a.parquet', branch: null, nav: 'chat' });
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('download failed: 404'));
  });
  describe('a file type the app does not know is checked before the tab shows it', () => {
    it('a binary file (the server says so) downloads and opens no tab', async () => {
      const tab = vi.spyOn(openFileTabMod, 'openFileTab');
      const sniff = vi.spyOn(api, 'sniffFile').mockResolvedValue({ binary: true });
      const save = vi.spyOn(saveFiles, 'saveFileAs').mockResolvedValue();
      await openChipFile({ project: 's1', path: 'models/x.pt', rel: 'models/x.pt', branch: null, nav: 'chat' });
      expect(sniff).toHaveBeenCalledWith('s1', 'models/x.pt');
      expect(save).toHaveBeenCalledWith('/api/sessions/s1/files/download?path=models%2Fx.pt', 'x.pt');
      expect(tab).not.toHaveBeenCalled();
    });
    it('a text file opens the tab', async () => {
      const tab = vi.spyOn(openFileTabMod, 'openFileTab').mockResolvedValue('ft1');
      vi.spyOn(api, 'sniffFile').mockResolvedValue({ binary: false });
      await openChipFile({ project: 's1', path: 'notes/x.weird', rel: 'notes/x.weird', branch: null, nav: 'threads' });
      expect(tab).toHaveBeenCalledWith('s1', 'notes/x.weird', { focus: true });
    });
    it('a failed check opens the tab, which shows its own error', async () => {
      const tab = vi.spyOn(openFileTabMod, 'openFileTab').mockResolvedValue('ft1');
      vi.spyOn(api, 'sniffFile').mockRejectedValue(new Error('403'));
      await openChipFile({ project: 's1', path: 'a.weird', rel: 'a.weird', branch: null, nav: 'threads' });
      expect(tab).toHaveBeenCalled();
    });
    it('a known text type is not checked', async () => {
      vi.spyOn(openFileTabMod, 'openFileTab').mockResolvedValue('ft1');
      const sniff = vi.spyOn(api, 'sniffFile');
      await openChipFile({ project: 's1', path: 'a.py', rel: 'a.py', branch: null, nav: 'threads' });
      expect(sniff).not.toHaveBeenCalled();
    });
  });
});
