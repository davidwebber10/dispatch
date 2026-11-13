import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ThreadMenu } from './ThreadMenu';
import { usePluginRegistry } from '../../plugins/registry';
import { useTabs } from '../../stores/tabs';
import * as push from '../../lib/push';
import type { Terminal } from '../../api/types';
import { Sparkle } from '@phosphor-icons/react';

// The phone's thread sheet (2026-11-07): it was 15 equal-weight text rows. Now a grid of the four
// most used actions, a short View group, the plugins' rows under a label, the rare maintenance
// actions behind a More disclosure, and Archive last in red. Every row carries an icon.

const tab = (over: Partial<Terminal> = {}): Terminal => ({ id: 't1', sessionId: 's1', type: 'claude-code', label: 'Fix the login bug', config: {}, status: 'waiting', createdAt: '2026-11-07T00:00:00Z', ...over } as Terminal);

function asPhone(on: boolean) {
  Object.defineProperty(window, 'innerWidth', { value: on ? 390 : 1024, configurable: true, writable: true });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: on, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
}

const open = (t: Terminal = tab(), extra: Partial<React.ComponentProps<typeof ThreadMenu>> = {}) =>
  render(<ThreadMenu at={{ tab: t, x: 10, y: 10 }} onClose={() => {}} onBranched={() => {}} {...extra} />);

beforeEach(() => {
  usePluginRegistry.setState({ views: [], settings: [], threadMenu: [], projectMenu: [], composerActions: [], slots: [], promoted: [], manifests: [], status: {} });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));
  vi.spyOn(push, 'canReceiveAlerts').mockReturnValue(true);
  asPhone(true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('the phone thread sheet', () => {
  it('leads with a grid of four icon tiles: Rename, Branch, Account, Alerts', () => {
    open();
    const grid = screen.getByRole('group', { name: 'Quick actions' });
    const tiles = within(grid).getAllByRole('button');
    expect(tiles.map((b) => b.getAttribute('aria-label'))).toEqual(['Rename thread', 'Branch thread', 'Switch account…', 'Enable alerts']);
    expect(tiles.map((b) => b.textContent)).toEqual(['Rename', 'Branch', 'Account', 'Alerts']);
    for (const b of tiles) expect(b.querySelector('svg')).not.toBeNull();
  });

  it('the Alerts tile shows its state and calls the same toggle', () => {
    const setAlertsEnabled = vi.fn(async () => {});
    useTabs.setState({ setAlertsEnabled } as any);
    open(tab({ config: { alertsEnabled: true } as any }));
    const alerts = screen.getByRole('button', { name: 'Disable alerts' });
    expect(alerts).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(alerts);
    expect(setAlertsEnabled).toHaveBeenCalledWith('t1', false);
  });

  it('a shell thread gets only the tiles that apply', () => {
    open(tab({ type: 'shell' }));
    const tiles = within(screen.getByRole('group', { name: 'Quick actions' })).getAllByRole('button');
    expect(tiles.map((b) => b.getAttribute('aria-label'))).toEqual(['Rename thread']);
  });

  it('the Rename tile opens the rename dialog', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Rename thread' }));
    expect(screen.getByDisplayValue('Fix the login bug')).toBeInTheDocument();
  });

  // Owner, 2026-11-13: "View Thread Details on mobile is just another list item, not a separate section".
  it('the caller row and Thread details are the first rows of the list, with no View section', () => {
    open(tab(), { leadView: (close, row) => <button type="button" style={row} onClick={close}><svg />Switch to Pretty</button> });
    expect(screen.queryByRole('group', { name: 'View' })).toBeNull();
    expect(screen.queryByText('View')).toBeNull();
    const rows = within(screen.getByTestId('thread-menu-list')).getAllByRole('button');
    expect(rows.slice(0, 2).map((b) => b.textContent)).toEqual(['Switch to Pretty', 'Thread details']);
    for (const b of rows.slice(0, 2)) expect(b.querySelector('svg')).not.toBeNull();
  });

  // Owner, 2026-11-13: on the phone the sheet opens at a fixed height; the four tiles stay at the top and
  // never go above the screen; the rows under them scroll.
  it('the sheet has a fixed height, the tiles stay outside the scrolling list, and the list scrolls', () => {
    open();
    const sheet = screen.getByTestId('thread-menu-sheet');
    expect(sheet.style.height).toMatch(/dvh/);
    const list = screen.getByTestId('thread-menu-list');
    expect(list.style.overflowY).toBe('auto');
    expect(list.contains(screen.getByRole('group', { name: 'Quick actions' }))).toBe(false);
    expect(within(list).getByRole('button', { name: 'Archive thread' })).toBeInTheDocument();
  });

  it('plugin rows (the caller\'s tabs and the registry\'s items) sit together under a Plugins label', () => {
    const onPick = vi.fn();
    usePluginRegistry.getState().register('previews', { threadMenu: [{ id: 'open', label: 'Previews', icon: 'eye', onPick }] });
    const tabPick = vi.fn();
    open(tab(), { pluginRows: [{ key: 'coach', label: 'Coach', icon: Sparkle, onPick: tabPick }] });
    const group = screen.getByRole('group', { name: 'Plugins' });
    expect(within(group).getByText('Plugins')).toBeInTheDocument();
    const rows = within(group).getAllByRole('button');
    expect(rows.map((b) => b.textContent)).toEqual(['Coach', 'Previews']);
    for (const b of rows) expect(b.querySelector('svg')).not.toBeNull();
    fireEvent.click(rows[1]);
    expect(onPick).toHaveBeenCalledWith({ tab: expect.objectContaining({ id: 't1' }) });
  });

  it('no plugins, no Plugins label', () => {
    open();
    expect(screen.queryByRole('group', { name: 'Plugins' })).toBeNull();
    expect(screen.queryByText('Plugins')).toBeNull();
  });

  // Owner, 2026-11-13: "we can just remove the More ... it should just show the options".
  it('shows the maintenance actions directly, with no More fold, each explained in one line', () => {
    open();
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reset status' })).toHaveAccessibleDescription('Clear a stuck Working or Needs-you state');
    expect(screen.getByRole('button', { name: 'Reload thread' })).toHaveAccessibleDescription('Reconnect to the thread');
    expect(screen.getByRole('button', { name: 'Copy thread ID' })).toHaveAccessibleDescription(/.+/);
    expect(screen.getByRole('button', { name: 'Auto-archive…' })).toHaveAccessibleDescription(/.+/);
    for (const name of ['Copy thread ID', 'Reload thread', 'Reset status', 'Auto-archive…']) expect(screen.getByRole('button', { name }).querySelector('svg')).not.toBeNull();
  });

  it('ends with Archive thread in the danger color, with an icon', () => {
    open();
    const all = within(screen.getByRole('menu')).getAllByRole('button');
    const last = all[all.length - 1];
    expect(last).toHaveAccessibleName('Archive thread');
    expect(last.style.color).toBe('var(--color-status-red)');
    expect(last.querySelector('svg')).not.toBeNull();
  });
});

describe('the desktop thread menu uses the same groups (a fly-out, not a flat list)', () => {
  it('shows the tiles and every action directly, with no More fold', () => {
    asPhone(false);
    open();
    expect(screen.getByRole('group', { name: 'Quick actions' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    for (const name of ['Rename thread', 'Branch thread', 'Copy thread ID', 'Reload thread', 'Reset status', 'Auto-archive…', 'Switch account…', 'Enable alerts', 'Archive thread']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });
});
