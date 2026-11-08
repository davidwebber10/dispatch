import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ThreadMenu } from './ThreadMenu';
import { usePluginRegistry } from '../../plugins/registry';
import type { Terminal } from '../../api/types';

const tab = (over: Partial<Terminal> = {}): Terminal => ({ id: 't1', sessionId: 's1', type: 'claude-code', label: 'Fix the login bug', config: {}, status: 'waiting', createdAt: '2026-11-07T00:00:00Z', ...over } as Terminal);

beforeEach(() => {
  usePluginRegistry.setState({ views: [], settings: [], threadMenu: [], projectMenu: [], composerActions: [], slots: [], promoted: [], manifests: [], status: {} });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));
});

describe('ThreadMenu plugin items (2026-11-07)', () => {
  it('a plugin item shows for a thread in the Plugins group, and calls onPick with the tab then closes', () => {
    const onPick = vi.fn();
    usePluginRegistry.getState().register('daily-rundown', { threadMenu: [{ id: 'pin', label: 'Pin to rundown', onPick }] });
    const onClose = vi.fn();
    render(<ThreadMenu at={{ tab: tab(), x: 10, y: 10 }} onClose={onClose} onBranched={() => {}} />);
    expect(within(screen.getByRole('group', { name: 'Plugins' })).getByRole('button', { name: 'Pin to rundown' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pin to rundown' }));
    expect(onPick).toHaveBeenCalledWith({ tab: expect.objectContaining({ id: 't1' }) });
    expect(onClose).toHaveBeenCalled();
  });

  it('`when` hides an item for a thread it does not apply to', () => {
    usePluginRegistry.getState().register('p', { threadMenu: [{ id: 'cc-only', label: 'Claude only', when: ({ tab: t }) => t.type === 'claude-code', onPick: () => {} }] });
    const { unmount } = render(<ThreadMenu at={{ tab: tab({ type: 'shell' }), x: 0, y: 0 }} onClose={() => {}} onBranched={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Claude only' })).toBeNull();
    unmount();
    render(<ThreadMenu at={{ tab: tab(), x: 0, y: 0 }} onClose={() => {}} onBranched={() => {}} />);
    expect(screen.getByRole('button', { name: 'Claude only' })).toBeInTheDocument();
  });

  it('a plugin item with a badge shows its count on the row, live, and the hook gives the ⋯ dot for that thread (2026-11-07)', async () => {
    const { act, renderHook } = await import('@testing-library/react');
    const { useThreadMenuBadge } = await import('../../plugins/menuBadge');
    let counts: Record<string, number> = { s1: 2, s2: 0 };
    const subs = new Set<() => void>();
    const badge = { subscribe: (cb: () => void) => { subs.add(cb); return () => subs.delete(cb); }, get: ({ tab: t }: { tab: Terminal }) => counts[t.sessionId] ?? 0 };
    usePluginRegistry.getState().register('previews', { threadMenu: [{ id: 'open', label: 'Previews', badge, onPick: () => {} }] });
    render(<ThreadMenu at={{ tab: tab(), x: 0, y: 0 }} onClose={() => {}} onBranched={() => {}} />);
    expect(screen.getByRole('button', { name: /Previews/ }).textContent).toContain('2');
    expect(screen.getByLabelText('2 new')).toBeInTheDocument();
    const s1 = renderHook(() => useThreadMenuBadge(tab()));
    const s2 = renderHook(() => useThreadMenuBadge(tab({ sessionId: 's2' })));
    expect(s1.result.current).toBe(2);
    expect(s2.result.current).toBe(0);
    act(() => { counts = { s1: 0, s2: 1 }; subs.forEach((cb) => cb()); });
    expect(s1.result.current).toBe(0);
    expect(s2.result.current).toBe(1);
    expect(screen.queryByLabelText('2 new')).toBeNull();
    expect(renderHook(() => useThreadMenuBadge(null)).result.current).toBe(0);
  });
});
