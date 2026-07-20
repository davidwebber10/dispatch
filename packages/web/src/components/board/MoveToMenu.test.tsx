import { render, screen, within, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MoveToMenu, decidePopoverDirection } from './MoveToMenu';
import { api } from '../../api/client';

vi.mock('../../api/client', () => ({
  api: { archiveTerminal: vi.fn().mockResolvedValue(undefined) },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function renderMenu(onOverride = vi.fn(), trigger: 'button' | 'longpress' = 'button') {
  render(
    <MoveToMenu terminalId="t1" onOverride={onOverride} trigger={trigger}>
      <div data-testid="card">Card content</div>
    </MoveToMenu>,
  );
  return onOverride;
}

// Opens the menu via whichever trigger this render used — the ⋯ button (desktop) or a
// contextmenu event standing in for a mobile long-press (see the component's own comment on
// why contextmenu is the deliberate proxy for long-press here).
function open(trigger: 'button' | 'longpress' = 'button') {
  if (trigger === 'button') {
    fireEvent.click(screen.getByRole('button', { name: 'Move to…' }));
  } else {
    fireEvent.contextMenu(screen.getByTestId('move-to-menu-wrap'));
  }
}

describe('MoveToMenu — trigger', () => {
  it('is closed by default', () => {
    renderMenu();
    expect(screen.queryByTestId('move-to-menu')).not.toBeInTheDocument();
  });

  it('the ⋯ button opens it on the default (desktop) trigger', () => {
    renderMenu();
    open('button');
    expect(screen.getByTestId('move-to-menu')).toBeInTheDocument();
  });

  it('the longpress trigger renders no visible ⋯ button', () => {
    renderMenu(vi.fn(), 'longpress');
    expect(screen.queryByRole('button', { name: 'Move to…' })).not.toBeInTheDocument();
  });

  it('a contextmenu event (long-press proxy) opens it on the longpress trigger', () => {
    renderMenu(vi.fn(), 'longpress');
    open('longpress');
    expect(screen.getByTestId('move-to-menu')).toBeInTheDocument();
  });
});

describe('MoveToMenu — offered targets', () => {
  it('offers exactly three targets, in order: Needs help, Complete, Resting', () => {
    renderMenu();
    open();
    // Scoped to the move-to-targets group specifically (not the whole menu) so this stays exactly
    // three even though Archive — a deliberately different kind of action, see below — also
    // renders as a <button> inside the same panel.
    const targets = screen.getByTestId('move-to-targets');
    const rows = within(targets).getAllByRole('button');
    expect(rows.map((r) => r.textContent?.replace('◆', '').trim())).toEqual(['Needs help', 'Complete', 'Resting']);
  });

  // The design rule most likely to be silently violated by a later edit (per the task brief):
  // Working is an observed fact, not a judgement, and the core route rejects it with a 400.
  // Assert its absence explicitly rather than only asserting the positive three exist.
  it('never offers Working', () => {
    renderMenu();
    open();
    const menu = screen.getByTestId('move-to-menu');
    expect(within(menu).queryByText(/working/i)).not.toBeInTheDocument();
    expect(within(menu).queryByRole('button', { name: /working/i })).not.toBeInTheDocument();
  });
});

// Each case below renders FRESH and performs exactly one interaction, then asserts BOTH that
// onOverride fired once AND with the exact expected target. Clicking all three targets in one
// shared render and asserting "one call each, in some order" would pass even if two of the
// three handlers were swapped — that exact weakness has already been caught twice on this
// project (per the task brief), so it is deliberately not the shape used here.
describe('MoveToMenu — choosing a target', () => {
  it('choosing "Needs help" calls onOverride with needs_help, and only once', () => {
    const onOverride = renderMenu();
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Needs help' }));
    expect(onOverride).toHaveBeenCalledTimes(1);
    expect(onOverride).toHaveBeenCalledWith('t1', 'needs_help');
  });

  it('choosing "Complete" calls onOverride with complete, and only once', () => {
    const onOverride = renderMenu();
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Complete' }));
    expect(onOverride).toHaveBeenCalledTimes(1);
    expect(onOverride).toHaveBeenCalledWith('t1', 'complete');
  });

  it('choosing "Resting" calls onOverride with resting, and only once', () => {
    const onOverride = renderMenu();
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Resting' }));
    expect(onOverride).toHaveBeenCalledTimes(1);
    expect(onOverride).toHaveBeenCalledWith('t1', 'resting');
  });
});

describe('MoveToMenu — closing', () => {
  it('closes after choosing a target', () => {
    renderMenu();
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Complete' }));
    expect(screen.queryByTestId('move-to-menu')).not.toBeInTheDocument();
  });

  it('closes on an outside click', () => {
    renderMenu();
    open();
    expect(screen.getByTestId('move-to-menu')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('move-to-menu')).not.toBeInTheDocument();
  });

  it('stays open when the mousedown lands inside the panel itself', () => {
    renderMenu();
    open();
    fireEvent.mouseDown(screen.getByTestId('move-to-menu'));
    expect(screen.getByTestId('move-to-menu')).toBeInTheDocument();
  });
});

// Archive is restored per the approved redesign (Open #3/#8B): below a divider, separate from
// the three move targets, because archiving is a different KIND of act — not a fourth column.
describe('MoveToMenu — Archive', () => {
  it('is present in the menu', () => {
    renderMenu();
    open();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
  });

  it('is visually separated from the move targets by a divider, positioned after them', () => {
    renderMenu();
    open();
    const menu = screen.getByTestId('move-to-menu');
    const children = Array.from(menu.querySelectorAll('[data-testid="move-to-targets"], [data-testid="move-to-menu-divider"], button[aria-label="Archive"]'));
    // The targets group comes first, then the divider, then Archive — never interleaved with
    // the three judgement targets above it.
    expect(children.map((el) => el.getAttribute('data-testid') || el.getAttribute('aria-label'))).toEqual([
      'move-to-targets',
      'move-to-menu-divider',
      'Archive',
    ]);
  });

  it('calls api.archiveTerminal with the terminal id, and only once', () => {
    renderMenu();
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(api.archiveTerminal).toHaveBeenCalledTimes(1);
    expect(api.archiveTerminal).toHaveBeenCalledWith('t1');
  });

  it('does not call onOverride when Archive is chosen', () => {
    const onOverride = renderMenu();
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(onOverride).not.toHaveBeenCalled();
  });

  it('closes the menu after choosing Archive', () => {
    renderMenu();
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(screen.queryByTestId('move-to-menu')).not.toBeInTheDocument();
  });
});

// The popover must open downward by default, anchored to its trigger, and auto-flip upward only
// when it would overflow the viewport's bottom edge. jsdom has no layout engine — every rect it
// hands back is zeroed — so the actual flip can only be exercised through the pure decision
// function the component defers to, not through rendered measurements.
describe('decidePopoverDirection', () => {
  it('opens downward when the panel fits in the space below the anchor', () => {
    // Anchor near the top of a tall viewport — plenty of room below.
    expect(decidePopoverDirection({ top: 40, bottom: 60 }, 160, 900)).toBe('down');
  });

  it('flips upward when opening downward would overflow the viewport', () => {
    // Anchor near the very bottom of the viewport — the panel does not fit below it.
    expect(decidePopoverDirection({ top: 860, bottom: 880 }, 160, 900)).toBe('up');
  });

  it('is downward exactly at the fit boundary (space below == panel height + gap)', () => {
    // viewportHeight - bottom - gap === panelHeight exactly: still fits, so still 'down'.
    const gap = 6;
    const panelHeight = 160;
    const bottom = 900 - gap - panelHeight;
    expect(decidePopoverDirection({ top: bottom - 20, bottom }, panelHeight, 900, gap)).toBe('down');
  });

  it('flips upward the moment it would overflow by even one pixel', () => {
    const gap = 6;
    const panelHeight = 160;
    const bottom = 900 - gap - panelHeight + 1;
    expect(decidePopoverDirection({ top: bottom - 20, bottom }, panelHeight, 900, gap)).toBe('up');
  });
});
