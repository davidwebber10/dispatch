import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useGroups } from './store';
import { useTabs } from '../../stores/tabs';
import { setDraft, getDraft, hasDraft, clearDraft } from '../../lib/fileDrafts';
import { leafTabIds } from './types';

/* closeGroup closes tabs through useTabs.closeTab, which became ABORTABLE when the unsaved-changes
   guard landed: a dirty tab prompts, and the user can say no. Everything below pins the resulting
   contract — the group and its tabs live or die TOGETHER, never half of each. */
describe('closeGroup with unsaved tabs', () => {
  beforeEach(() => {
    useGroups.setState({ groups: {}, tabGroup: {} });
    useTabs.setState({
      openTabIds: ['t1', 't2', 't3'],
      activeTabId: 't1',
      tabSession: { t1: 's1', t2: 's1', t3: 's1' },
      dirtyTabs: {},
    });
    // Drafts are module-level and outlive any one test — reset them so they cannot leak.
    clearDraft('t1');
    clearDraft('t2');
    vi.restoreAllMocks();
  });

  /** A group of t1 + t2, with t3 left as a loose tab. */
  function group(): string {
    return useGroups.getState().merge('s1', 't1', 't2');
  }

  it('closes every tab in the group and removes the group when nothing is dirty', () => {
    const gid = group();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    useGroups.getState().closeGroup(gid);

    expect(confirm).not.toHaveBeenCalled();               // nothing to lose, so nothing to ask
    expect(useTabs.getState().openTabIds).toEqual(['t3']);
    expect(useGroups.getState().groups[gid]).toBeUndefined();
    expect(useGroups.getState().tabGroup.t1).toBeUndefined();
  });

  it('asks ONCE for the whole group, not once per dirty tab', () => {
    const gid = group();
    useTabs.getState().setTabDirty('t1', true);
    useTabs.getState().setTabDirty('t2', true);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    useGroups.getState().closeGroup(gid);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('2 files have unsaved changes'));
    expect(useTabs.getState().openTabIds).toEqual(['t3']);
    expect(useGroups.getState().groups[gid]).toBeUndefined();
  });

  it('declining leaves BOTH the tab and its group intact', () => {
    const gid = group();
    setDraft('t1', 'name,qty\nkiwis,3\n');
    useTabs.getState().setTabDirty('t1', true);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    useGroups.getState().closeGroup(gid);

    expect(confirm).toHaveBeenCalledTimes(1);
    // The tab is still open...
    expect(useTabs.getState().openTabIds).toEqual(['t1', 't2', 't3']);
    expect(useTabs.getState().dirtyTabs.t1).toBe(true);
    expect(getDraft('t1')).toBe('name,qty\nkiwis,3\n');   // ...with its unsaved edit...
    // ...and so is the pane group it lives in. Tearing the layout down here would be destroying
    // something the user just declined to destroy.
    const g = useGroups.getState().groups[gid];
    expect(g).toBeDefined();
    expect(leafTabIds(g!.layout)).toEqual(['t1', 't2']);
    expect(useGroups.getState().tabGroup.t1).toBe(gid);
    expect(useGroups.getState().tabGroup.t2).toBe(gid);
  });

  it('confirming discards the drafts of every tab in the group', () => {
    const gid = group();
    setDraft('t1', 'a,b\n1,2\n');
    useTabs.getState().setTabDirty('t1', true);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    useGroups.getState().closeGroup(gid);

    expect(hasDraft('t1')).toBe(false);   // discarded for real — reopening shows what is on disk
    expect(useTabs.getState().dirtyTabs.t1).toBeUndefined();
  });

  it('does not re-prompt per tab once the group-level confirm is accepted', () => {
    const gid = group();
    useTabs.getState().setTabDirty('t1', true);
    useTabs.getState().setTabDirty('t2', true);
    // A second prompt would mean closeTab was called WITHOUT force — i.e. a decline could still
    // strand a partially-closed group.
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    useGroups.getState().closeGroup(gid);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(useTabs.getState().openTabIds).toEqual(['t3']);
  });
});
