import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openChipFile } from './openChipFile';
import * as openFileTabMod from './openFileTab';
import * as saveFiles from './saveFiles';
import { useDocViewer } from '../stores/docViewer';
import { useUI } from '../stores/ui';

beforeEach(() => {
  vi.restoreAllMocks();
  useDocViewer.setState({ open: null, back: [] });
  useUI.setState({ pendingOpenThread: null, view: 'chat' } as never);
});

describe('openChipFile', () => {
  it('a doc opens the doc viewer, in the viewer of a view that has an origin', async () => {
    const tab = vi.spyOn(openFileTabMod, 'openFileTab');
    await openChipFile({ project: 's1', path: 'docs/a.md', branch: 'b', nav: 'chat' });
    expect(useDocViewer.getState().open).toEqual({ project: 's1', path: 'docs/a.md', branch: 'b' });
    await openChipFile({ project: 's1', path: 'n.txt', branch: null, nav: 'threads', origin: 't9' });
    expect(useDocViewer.getState().open).toEqual({ project: 's1', path: 'n.txt', branch: null, origin: 't9' });
    expect(tab).not.toHaveBeenCalled();
  });
  it('a text file opens a file tab; nav threads asks for it to come to front', async () => {
    const tab = vi.spyOn(openFileTabMod, 'openFileTab').mockResolvedValue('ft1');
    await openChipFile({ project: 's1', path: 'scripts/extract.py', branch: null, nav: 'threads' });
    expect(tab).toHaveBeenCalledWith('s1', 'scripts/extract.py', { focus: true });
    expect(useDocViewer.getState().open).toBeNull();
  });
  it('nav stay opens the tab and stays put', async () => {
    const tab = vi.spyOn(openFileTabMod, 'openFileTab').mockResolvedValue('ft1');
    await openChipFile({ project: 's1', path: 'a.py', branch: null, nav: 'stay' });
    expect(tab).toHaveBeenCalledWith('s1', 'a.py', { focus: false });
    expect(useUI.getState().pendingOpenThread).toBeNull();
  });
  it('from Chat, a file tab opens in the Threads view (desktop and phone read the same request)', async () => {
    vi.spyOn(openFileTabMod, 'openFileTab').mockResolvedValue('ft1');
    await openChipFile({ project: 's1', path: 'a.py', branch: null, nav: 'chat' });
    expect(useUI.getState().pendingOpenThread).toEqual({ sessionId: 's1', terminalId: 'ft1' });
    expect(useUI.getState().view).toBe('workspace');
  });
  it('from Chat, a tab that could not be made opens nothing', async () => {
    vi.spyOn(openFileTabMod, 'openFileTab').mockResolvedValue(null);
    await openChipFile({ project: 's1', path: 'a.py', branch: null, nav: 'chat' });
    expect(useUI.getState().pendingOpenThread).toBeNull();
    expect(useUI.getState().view).toBe('chat');
  });
  it('an image opens a file tab (the file tab shows images)', async () => {
    const tab = vi.spyOn(openFileTabMod, 'openFileTab').mockResolvedValue('ft1');
    await openChipFile({ project: 's1', path: 'img/shot.png', branch: null, nav: 'threads' });
    expect(tab).toHaveBeenCalledWith('s1', 'img/shot.png', { focus: true });
  });
  it('a binary file with no viewer downloads from the project and opens no tab', async () => {
    const tab = vi.spyOn(openFileTabMod, 'openFileTab');
    const save = vi.spyOn(saveFiles, 'saveFileAs').mockResolvedValue();
    await openChipFile({ project: 's1', path: '/w/app/data/out.xlsx', branch: null, nav: 'chat' });
    expect(save).toHaveBeenCalledWith('/api/sessions/s1/files/download?path=%2Fw%2Fapp%2Fdata%2Fout.xlsx', 'out.xlsx');
    expect(tab).not.toHaveBeenCalled();
  });
  it('a failed download tells the reader', async () => {
    vi.spyOn(saveFiles, 'saveFileAs').mockRejectedValue(new Error('download failed: 404'));
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    await openChipFile({ project: 's1', path: 'a.parquet', branch: null, nav: 'chat' });
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('download failed: 404'));
  });
});
