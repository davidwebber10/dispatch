import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useTabs } from './tabs';

describe('unsaved-changes guard', () => {
  beforeEach(() => {
    useTabs.setState({ openTabIds: ['t1', 't2'], activeTabId: 't1', tabSession: { t1: 's1', t2: 's1' }, dirtyTabs: {} });
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
});
