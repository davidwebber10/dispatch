// Ledger chips in the Control Plane chat (pinned card spec 2026-10-08, Unit 9): overseer replies,
// the user's own messages, the agency notice pills and the report_status cards. A chip click opens
// the item on the pinned card, or a small popover when the item is not on the card.
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { m } from '../data';
import { useOverseer } from '../store';
import { useProjects } from '../../../stores/projects';
import { useUI } from '../../../stores/ui';
import { useLedgerCard, useLedgerFolds } from '../../../stores/ledgerCard';
import { ConversationStream } from './Stream';
import { LedgerCard } from './LedgerCard';
import { LedgerRefPopover, openLedgerRef } from './LedgerChips';
import { FIXTURE } from '../ledger-fixture';
import type { StreamMessage } from '../types';

beforeAll(() => {
  class Noop { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Noop;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Noop;
  Element.prototype.scrollTo = Element.prototype.scrollTo || (() => {});
});

beforeEach(() => {
  localStorage.clear();
  useProjects.setState({ activeId: 'proj-1' });
  useOverseer.setState({ coordinatorId: 'coord-1', coordinatorProject: 'proj-1', coordinatorStream: [], coordinatorBusy: false, coordinatorPending: null, coordinatorAnswer: () => {}, mobileTab: 'stream' });
  useLedgerCard.setState({ byProject: { 'proj-1': { card: FIXTURE, loading: false, error: null, request: 1 } }, focus: null, popover: null });
  useLedgerFolds.setState({ open: {} });
  useUI.setState({ rightCollapsed: true, inspectorTab: 'files' });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const chipSeqs = () => [...document.querySelectorAll('[data-ledger-chip]')].map((c) => Number(c.getAttribute('data-ledger-chip')));
const stream = (msgs: StreamMessage[]) => useOverseer.setState({ coordinatorStream: msgs });

describe('chips in the Control Plane chat', () => {
  it('an overseer reply: known numbers become chips with the question, never inside code; unknown ones stay plain', () => {
    stream([m('overseer', 'Control Plane', 'N14 and N12 wait on you. N99 is unknown. Type `show N14`.', '', 'o1')]);
    render(<ConversationStream />);
    expect(chipSeqs()).toEqual([14, 12]);
    const chip = document.querySelector('[data-ledger-chip="14"]')!;
    expect(chip.textContent).toBe('N14 · How many clean nights before live mode?');
    expect(chip.getAttribute('title')).toBe('How many clean nights before live mode?');
    expect(screen.getByText('show N14').tagName).toBe('CODE');
  });

  it('the user\'s own message, an agency notice pill and a report_status card', () => {
    stream([
      m('user', 'You', 'N12: approve, and hold N99', '', 'u1'),
      m('user', 'You', '✅ Your agent "N14 checker" [agentId t1] just finished a turn.', '', 'u2'),
      { ...m('status', null, '', '', 's1'), isStatus: true, statusInput: JSON.stringify({ state: 'needs_you', summary: 'Two items', ask: 'Answer N14 first.' }) },
    ]);
    render(<ConversationStream />);
    expect(chipSeqs()).toEqual([12, 14, 14]);
    expect(screen.getByText(/and hold N99/)).toBeInTheDocument();
  });

  it('a chip never uses another project\'s ledger', () => {
    useLedgerCard.setState({ byProject: { 'other': { card: FIXTURE, loading: false, error: null, request: 1 } } });
    stream([m('overseer', 'Control Plane', 'N14 waits.', '', 'o1'), m('user', 'You', 'N14: A', '', 'u1')]);
    render(<ConversationStream />);
    expect(chipSeqs()).toEqual([]);
  });
});

describe('a chip click', () => {
  it('an item on the card: opens the right pane on Details, unfolds its section, opens it as a full card and scrolls to it', () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    stream([m('overseer', 'Control Plane', 'N5 runs on its default.', '', 'o1')]);
    render(<><ConversationStream /><LedgerCard /></>);
    fireEvent.click(document.querySelector('[data-ledger-chip="5"]')!);
    expect(useUI.getState().rightCollapsed).toBe(false);
    expect(useUI.getState().inspectorTab).toBe('details');
    const full = document.querySelector('[data-ledger-seq="5"][data-full="true"]') as HTMLElement;
    expect(full).not.toBeNull();
    expect(useLedgerFolds.getState().open.onDefaults).toBe(true);
    expect(scroll.mock.contexts).toContain(full);
    expect(useLedgerCard.getState().focus).toBeNull(); // handled once
  });

  it('the card mounts after the click (the pane was collapsed): it still opens the item', () => {
    act(() => { openLedgerRef('proj-1', 9, { x: 0, y: 0 }, { mobile: false }); });
    render(<LedgerCard />);
    expect(document.querySelector('[data-ledger-seq="9"][data-full="true"]')).not.toBeNull();
  });

  it('mobile: switches to the Work tab', () => {
    act(() => { openLedgerRef('proj-1', 20, { x: 0, y: 0 }, { mobile: true }); });
    expect(useOverseer.getState().mobileTab).toBe('work');
    expect(useUI.getState().rightCollapsed).toBe(true); // the desktop pane is left alone
  });

  it('an item not on the card (answered long ago): a small popover with its question, status and answer', () => {
    stream([m('user', 'You', 'like N40 before', '', 'u1')]);
    render(<><ConversationStream /><LedgerRefPopover /></>);
    fireEvent.click(document.querySelector('[data-ledger-chip="40"]')!);
    const pop = within(screen.getByRole('dialog'));
    expect(pop.getByText('N40 · Use the staging bucket for the export test?')).toBeInTheDocument();
    expect(pop.getByText('Answered')).toBeInTheDocument();
    expect(pop.getByText('"yes, N40: A"')).toBeInTheDocument();
    expect(useUI.getState().rightCollapsed).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

// Review round 1: a project switch (Ctrl+Tab) must not leave one project's item over another.
describe('the popover and a project switch', () => {
  it('closes when the shown project changes, and never shows over another project', () => {
    useLedgerCard.setState({ byProject: { 'proj-1': { card: FIXTURE, loading: false, error: null, request: 1 }, 'proj-2': { card: FIXTURE, loading: false, error: null, request: 1 } } });
    act(() => { openLedgerRef('proj-1', 40, { x: 10, y: 10 }, { mobile: false }); });
    render(<LedgerRefPopover />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    act(() => { useProjects.setState({ activeId: 'proj-2' }); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(useLedgerCard.getState().popover).toBeNull();
    // A popover of another project, set while proj-2 shows, is not drawn.
    act(() => { useLedgerCard.getState().setPopover({ projectId: 'proj-1', seq: 40, x: 0, y: 0 }); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
