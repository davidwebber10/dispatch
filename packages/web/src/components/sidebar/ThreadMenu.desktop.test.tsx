import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ThreadMenu } from './ThreadMenu';
import { usePluginRegistry } from '../../plugins/registry';
import * as push from '../../lib/push';
import type { Terminal } from '../../api/types';
import { Sparkle } from '@phosphor-icons/react';

// The desktop thread menu (2026-11-07): the phone sheet's grouped layout, as a fly-out at the click.
// One body, two shells: the phone's slide-up sheet and this popover.

const tab = (over: Partial<Terminal> = {}): Terminal => ({ id: 't1', sessionId: 's1', type: 'claude-code', label: 'Fix the login bug', config: {}, status: 'waiting', createdAt: '2026-11-07T00:00:00Z', ...over } as Terminal);

function asDesktop(w = 1440, h = 900) {
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
  Object.defineProperty(window, 'innerHeight', { value: h, configurable: true, writable: true });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
}

const open = (t: Terminal = tab(), extra: Partial<React.ComponentProps<typeof ThreadMenu>> = {}, x = 40, y = 60) =>
  render(<ThreadMenu at={{ tab: t, x, y }} onClose={() => {}} onBranched={() => {}} {...extra} />);

const flyout = () => screen.getByRole('menu', { name: 'Thread options' });

beforeEach(() => {
  usePluginRegistry.setState({ views: [], settings: [], threadMenu: [], projectMenu: [], composerActions: [], slots: [], promoted: [], manifests: [], status: {} });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));
  vi.spyOn(push, 'canReceiveAlerts').mockReturnValue(true);
  asDesktop();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('the desktop thread fly-out', () => {
  it('is a popover, not a sheet: a fixed menu 300–340px wide with its own scroll', () => {
    open();
    const m = flyout();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(m.style.position).toBe('fixed');
    const w = parseInt(m.style.width, 10);
    expect(w).toBeGreaterThanOrEqual(300);
    expect(w).toBeLessThanOrEqual(340);
    expect(m.style.maxHeight).not.toBe('');
    expect(m.style.overflowY).toBe('auto');
  });

  it('leads with the same quick-action tiles as the phone', () => {
    open();
    const tiles = within(screen.getByRole('group', { name: 'Quick actions' })).getAllByRole('button');
    expect(tiles.map((b) => b.getAttribute('aria-label'))).toEqual(['Rename thread', 'Branch thread', 'Switch account…', 'Enable alerts']);
    for (const b of tiles) expect(b.querySelector('svg')).not.toBeNull();
  });

  it('shows the maintenance rows directly (no More fold, 2026-11-13), and ends with Archive in red', () => {
    open();
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    for (const name of ['Copy thread ID', 'Reload thread', 'Reset status', 'Auto-archive…']) expect(screen.getByRole('button', { name })).toBeInTheDocument();
    const all = within(flyout()).getAllByRole('button');
    expect(all[all.length - 1]).toHaveAccessibleName('Archive thread');
    expect(all[all.length - 1].style.color).toBe('var(--color-status-red)');
  });

  it('groups plugin rows under Plugins, with icons', () => {
    usePluginRegistry.getState().register('previews', { threadMenu: [{ id: 'open', label: 'Previews', icon: 'eye', onPick: () => {} }] });
    open(tab(), { pluginRows: [{ key: 'coach', label: 'Coach', icon: Sparkle, onPick: () => {} }] });
    const rows = within(screen.getByRole('group', { name: 'Plugins' })).getAllByRole('button');
    expect(rows.map((b) => b.textContent)).toEqual(['Coach', 'Previews']);
    for (const b of rows) expect(b.querySelector('svg')).not.toBeNull();
  });

  it('leaves Thread details to the right-hand panel, as before', () => {
    open();
    expect(screen.queryByRole('button', { name: 'Thread details' })).toBeNull();
  });

  it('stays inside the viewport near the right and bottom edges', () => {
    asDesktop(1024, 768);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 320, height: 420, top: 0, left: 0, right: 320, bottom: 420, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    open(tab(), {}, 1010, 740);
    const m = flyout();
    const left = parseFloat(m.style.left), top = parseFloat(m.style.top);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + 320).toBeLessThanOrEqual(1024 - 8);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top + 420).toBeLessThanOrEqual(768 - 8);
  });

  it('a tall fly-out opened low stays inside the viewport (every row shows at once, 2026-11-13)', () => {
    asDesktop(1024, 768);
    const h = 428;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width: 320, height: h, top: 0, left: 0, right: 320, bottom: h, x: 0, y: 0, toJSON: () => ({}) } as DOMRect));
    open(tab(), {}, 200, 500);
    const top = parseFloat(flyout().style.top);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top + 428).toBeLessThanOrEqual(768 - 8);
  });

  it('closes on Escape and on a click outside', () => {
    const onClose = vi.fn();
    render(<ThreadMenu at={{ tab: tab(), x: 40, y: 60 }} onClose={onClose} onBranched={() => {}} />);
    fireEvent.keyDown(flyout(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('thread-menu-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('moves focus with the arrow keys, tiles included, and wraps; Home and End jump', () => {
    open();
    const items = within(flyout()).getAllByRole('button');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(flyout(), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(flyout(), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(flyout(), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(flyout(), { key: 'ArrowUp' });
    fireEvent.keyDown(flyout(), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(flyout(), { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(flyout(), { key: 'End' });
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it('a parent re-render (a fresh onClose) does not pull the focus back to the first item', () => {
    const at = { tab: tab(), x: 40, y: 60 };
    const { rerender } = render(<ThreadMenu at={at} onClose={() => {}} onBranched={() => {}} />);
    fireEvent.keyDown(flyout(), { key: 'ArrowDown' });
    const second = document.activeElement;
    rerender(<ThreadMenu at={at} onClose={() => {}} onBranched={() => {}} />);
    expect(document.activeElement).toBe(second);
  });

  it('arrow keys reach the maintenance rows', () => {
    open();
    const prev = screen.getByRole('button', { name: 'Copy thread ID' });
    const rows = within(flyout()).getAllByRole('button');
    rows[rows.indexOf(prev) - 1].focus();
    fireEvent.keyDown(flyout(), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Copy thread ID' }));
  });
});
