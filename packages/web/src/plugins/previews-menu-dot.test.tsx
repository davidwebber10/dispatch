import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, renderHook, waitFor } from '@testing-library/react';
import { createPluginSdk } from './facade';
import { usePluginRegistry, type InspectorTabCtx, type MenuBadge } from './registry';
import { useThreadMenuBadge } from './menuBadge';
import { useProjects } from '../stores/projects';
import type { Terminal } from '../api/types';
// The bundled Previews plugin is plain JS.
import activate from '../../../plugins/previews/web.js';

// v4.5.2 (owner, 2026-11-11): "previews aren't showing the bubble on three dots inside the thread
// anymore". v4.5.0 removed the "Project previews" thread-menu item, and that item's badge was the only
// thing that put the dot on ⋯. The thread's Previews tab now carries the count of ITS new previews:
// the ⋯ dot, the tab's row in the phone menu and the desktop tab all read it.

type Tab = { label: string; badge?: MenuBadge<InspectorTabCtx>; Component: React.ComponentType<{ terminalId: string | null; sessionId: string | null }> };
const doc = (id: string, terminalId: string, seenAt: string | null) =>
  ({ id, sessionId: 's1', sessionName: 'Alpha', terminalId, terminalLabel: terminalId, title: `Preview ${id}`, note: null, text: `text ${id}`, files: [], createdAt: '2026-11-11T10:00:00Z', seenAt });

describe('Previews: the thread tab counts the thread\'s new previews (the ⋯ dot)', () => {
  let tabs: Tab[];
  beforeEach(() => {
    useProjects.setState({ sessions: [{ id: 's1', name: 'Alpha' }] as never });
    const base = createPluginSdk('previews');
    tabs = [];
    const DOCS = [doc('a', 't1', null), doc('b', 't1', null), doc('c', 't1', 'seen'), doc('d', 't2', null)];
    const d = {
      ...base,
      docs: { ...base.docs, entries: vi.fn(async () => DOCS.map((v) => ({ key: `preview:${v.id}`, value: v }))), set: vi.fn(async () => {}) },
      events: { on: () => () => {} },
      register: (c: { inspectorTabs?: Tab[] }) => { tabs.push(...(c.inspectorTabs ?? [])); },
    };
    activate(d as never);
  });

  it('the tab has a badge with the unseen previews of that thread only', async () => {
    const badge = tabs[0].badge;
    expect(badge).toBeDefined();
    // Any render of the tab loads the store; t9 has no previews, so nothing is marked seen.
    const View = tabs[0].Component;
    render(<View terminalId="t9" sessionId="s1" />);
    await waitFor(() => expect(badge!.get({ terminalId: 't1', sessionId: 's1' })).toBe(2));
    expect(badge!.get({ terminalId: 't2', sessionId: 's1' })).toBe(1);
    expect(badge!.get({ terminalId: 't9', sessionId: 's1' })).toBe(0);
  });
});

describe('useThreadMenuBadge: the ⋯ dot also counts the right-column tabs', () => {
  beforeEach(() => {
    usePluginRegistry.getState().unregister('dot-test');
  });

  it('sums the badges of the inspector tabs for the open thread', () => {
    const badge: MenuBadge<InspectorTabCtx> = { subscribe: () => () => {}, get: ({ terminalId }) => (terminalId === 't1' ? 3 : 0) };
    usePluginRegistry.getState().register('dot-test', { inspectorTabs: [{ id: 'x', label: 'X', badge, Component: () => null }] });
    const t1 = { id: 't1', sessionId: 's1', type: 'claude-code' } as Terminal;
    const t2 = { id: 't2', sessionId: 's1', type: 'claude-code' } as Terminal;
    expect(renderHook(() => useThreadMenuBadge(t1)).result.current).toBe(3);
    expect(renderHook(() => useThreadMenuBadge(t2)).result.current).toBe(0);
  });
});
