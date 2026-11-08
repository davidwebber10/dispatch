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
});
