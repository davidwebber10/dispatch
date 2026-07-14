import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useTabs } from './tabs';
import { setDraft, hasDraft, getDraft, clearDraft } from '../lib/fileDrafts';

describe('unsaved-changes guard', () => {
  beforeEach(() => {
    useTabs.setState({ openTabIds: ['t1', 't2'], activeTabId: 't1', tabSession: { t1: 's1', t2: 's1' }, dirtyTabs: {} });
    // Drafts are module-level and outlive any one test — reset them so they can't leak.
    clearDraft('t1');
    clearDraft('t2');
    vi.restoreAllMocks();
  });

  it('closes a clean tab without prompting', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    useTabs.getState().closeTab('t1');
    expect(confirm).not.toHaveBeenCalled();
    expect(useTabs.getState().openTabIds).toEqual(['t2']);
  });

  it('prompts before closing a dirty tab, and keeps it open if you decline', () => {
    useTabs.getState().setTabDirty('t1', true);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    useTabs.getState().closeTab('t1');

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(useTabs.getState().openTabIds).toEqual(['t1', 't2']);   // still open — nothing lost
  });

  it('closes a dirty tab when you confirm, and forgets its dirty flag', () => {
    useTabs.getState().setTabDirty('t1', true);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    useTabs.getState().closeTab('t1');

    expect(useTabs.getState().openTabIds).toEqual(['t2']);
    expect(useTabs.getState().dirtyTabs.t1).toBeUndefined();
  });

  it('does not prompt when the server already removed the terminal', () => {
    useTabs.getState().setTabDirty('t1', true);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    useTabs.getState().closeTab('t1', { force: true });

    expect(confirm).not.toHaveBeenCalled();       // the file is gone; there is nothing to save
    expect(useTabs.getState().openTabIds).toEqual(['t2']);
  });

  // The unsaved edit itself lives in fileDrafts (it has to — TabHost unmounts inactive tabs, so
  // component state cannot hold it). closeTab therefore owns the draft's fate too.

  it('discards the draft when you confirm the close', () => {
    setDraft('t1', 'name,qty\nkiwis,3\n');
    useTabs.getState().setTabDirty('t1', true);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    useTabs.getState().closeTab('t1');

    expect(useTabs.getState().openTabIds).toEqual(['t2']);
    expect(hasDraft('t1')).toBe(false);   // discarded for real — reopening shows what's on disk
  });

  it('keeps the draft when you decline the close — the tab stayed open and the edit is still live', () => {
    setDraft('t1', 'name,qty\nkiwis,3\n');
    useTabs.getState().setTabDirty('t1', true);
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    useTabs.getState().closeTab('t1');

    expect(useTabs.getState().openTabIds).toEqual(['t1', 't2']);
    expect(getDraft('t1')).toBe('name,qty\nkiwis,3\n');   // nothing lost by asking
    expect(useTabs.getState().dirtyTabs.t1).toBe(true);
  });

  it('drops the draft of a tab the server removed', () => {
    setDraft('t1', 'name,qty\nkiwis,3\n');
    useTabs.getState().setTabDirty('t1', true);

    useTabs.getState().closeTab('t1', { force: true });

    expect(hasDraft('t1')).toBe(false);   // the file is gone; the draft would be orphaned
  });
});
