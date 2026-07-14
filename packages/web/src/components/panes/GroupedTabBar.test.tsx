import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { GroupedTabBar } from './GroupedTabBar';
import { useGroups } from './store';
import { useTabs } from '../../stores/tabs';
import { useSettings } from '../../stores/settings';
import type { Terminal } from '../../api/types';

/* The unsaved marker in the tab strip.

   FileEditorTab's "● unsaved" badge only renders while its tab is ACTIVE, and TabHost unmounts a
   backgrounded tab entirely — so an unsaved edit sitting in a background tab had NO visible sign
   anywhere in the UI. The whole point of drafts surviving backgrounding is that a tab can sit there
   with unsaved work; the strip is the surface that has to show it. */

function term(id: string, label: string): Terminal {
  return { id, sessionId: 's1', type: 'file', label, status: 'idle', config: {} } as unknown as Terminal;
}

describe('GroupedTabBar unsaved marker', () => {
  beforeEach(() => {
    useGroups.setState({ groups: {}, tabGroup: {} });
    useTabs.setState({
      byProject: { s1: [term('t1', 'data.csv'), term('t2', 'notes.md')] },
      openTabIds: ['t1', 't2'],
      activeTabId: 't2',          // t1 is in the BACKGROUND — the case with no signal before
      tabSession: { t1: 's1', t2: 's1' },
      dirtyTabs: {},
    });
    useSettings.setState({ multiPane: true });
  });

  it('marks a dirty BACKGROUND tab and leaves a clean one unmarked', () => {
    useTabs.getState().setTabDirty('t1', true);
    render(<GroupedTabBar />);

    // Exactly one marker, and it belongs to the dirty tab's chip — not the clean one.
    const marks = screen.getAllByTitle('Unsaved changes');
    expect(marks).toHaveLength(1);
    expect(marks[0].closest('div')).toHaveTextContent('data.csv');
  });

  it('shows no marker at all when every tab is clean', () => {
    render(<GroupedTabBar />);
    expect(screen.queryByTitle('Unsaved changes')).toBeNull();
  });

  it('tracks dirtiness LIVE — no re-render of the bar required', () => {
    render(<GroupedTabBar />);
    expect(screen.queryByTitle('Unsaved changes')).toBeNull();

    // dirtyTabs was previously only ever read through getState(), which does not subscribe: the
    // strip would never have repainted for either of these. Both assertions below fail unless the
    // chip is a real subscriber.
    act(() => { useTabs.getState().setTabDirty('t1', true); });   // ← an edit lands in a background tab
    expect(screen.getByTitle('Unsaved changes')).toBeInTheDocument();

    act(() => { useTabs.getState().setTabDirty('t1', false); });  // ← what save() does
    expect(screen.queryByTitle('Unsaved changes')).toBeNull();
  });

  it('a group chip speaks for its panes — it is the only strip presence they have', () => {
    useGroups.getState().merge('s1', 't1', 't2');
    useTabs.getState().setTabDirty('t1', true);
    render(<GroupedTabBar />);

    expect(screen.getByTitle('Unsaved changes in 1 pane')).toBeInTheDocument();
  });

  it('marks a dirty tab in the classic (non-multiPane) bar too', () => {
    useSettings.setState({ multiPane: false });
    useTabs.getState().setTabDirty('t1', true);
    render(<GroupedTabBar />);

    const marks = screen.getAllByTitle('Unsaved changes');
    expect(marks).toHaveLength(1);
    expect(marks[0].closest('div')).toHaveTextContent('data.csv');
  });
});
