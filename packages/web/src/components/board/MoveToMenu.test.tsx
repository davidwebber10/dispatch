import { render, screen, within, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MoveToMenu } from './MoveToMenu';

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
    const menu = screen.getByTestId('move-to-menu');
    const rows = within(menu).getAllByRole('button');
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
