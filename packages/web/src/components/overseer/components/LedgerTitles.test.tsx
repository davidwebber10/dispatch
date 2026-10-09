// Titles on the card and in the chips (titles and source panel spec 2026-10-09, Unit 9): a chip and
// a short row show "N41 · title"; a chip's hover text is the full question; a full card shows the
// title as its headline and the full question below it; the popover shows the title, the question,
// the status and the answer. An item without a title looks as it does today.
import { render, screen, fireEvent, cleanup, within, renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { m } from '../data';
import { useOverseer } from '../store';
import { useProjects } from '../../../stores/projects';
import { useLedgerCard, useLedgerFolds } from '../../../stores/ledgerCard';
import { ConversationStream } from './Stream';
import { LedgerCard } from './LedgerCard';
import { LedgerRefPopover, useLedgerChips } from './LedgerChips';
import { chipLabel } from '../../../lib/ledgerRefs';
import { FIXTURE, NOW } from '../ledger-fixture';
import type { CardItem, LedgerCard as Card } from '../../../api/types';
import type { StreamMessage } from '../types';

const TITLES: Record<number, string> = { 14: 'Clean nights before live mode', 9: 'Old tag check', 20: 'Check the staging banner', 40: 'Staging bucket for the export' };
const titled = (i: CardItem): CardItem => ({ ...i, title: TITLES[i.seq] ?? null });
const s = FIXTURE.sections;
const TITLED: Card = {
  ...FIXTURE,
  sections: {
    ...s,
    needsYou: { cards: s.needsYou.cards.map(titled), lines: s.needsYou.lines.map(titled) },
    actions: s.actions.map(titled),
  },
  index: FIXTURE.index.map((e) => ({ ...e, title: TITLES[e.seq] ?? null })),
};

beforeAll(() => {
  class Noop { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Noop;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Noop;
  Element.prototype.scrollTo = Element.prototype.scrollTo || (() => {});
});

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  localStorage.clear();
  useProjects.setState({ activeId: 'proj-1' });
  useOverseer.setState({ coordinatorId: 'coord-1', coordinatorProject: 'proj-1', coordinatorStream: [], coordinatorBusy: false, coordinatorPending: null, coordinatorAnswer: () => {}, mobileTab: 'stream' });
  useLedgerCard.setState({ byProject: { 'proj-1': { card: TITLED, loading: false, error: null, request: 1 } }, focus: null, popover: null });
  useLedgerFolds.setState({ open: {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

const fullCard = (seq: number) => document.querySelector(`[data-ledger-seq="${seq}"][data-full="true"]`) as HTMLElement;

describe('chipLabel', () => {
  it('the title when there is one; the question, cut at about 70 characters, when there is none', () => {
    expect(chipLabel(41, 'Do you approve the merge of board PR #26 (docs/BOARD.md update for 2026-10-09)?', 'Merge board PR #26')).toBe('N41 · Merge board PR #26');
    expect(chipLabel(41, 'Do you approve the merge of board PR #26 (docs/BOARD.md update for 2026-10-09)?', null))
      .toBe('N41 · Do you approve the merge of board PR #26 (docs/BOARD.md update for…'); // the spec's example
  });
});

describe('chips with titles', () => {
  it('in a reply and in plain text: "N14 · title", the full question on hover; an item without a title keeps its question', () => {
    useOverseer.setState({ coordinatorStream: [
      m('overseer', 'Control Plane', 'N14 and N12 wait on you.', '', 'o1'),
      m('user', 'You', 'N14: A', '', 'u1'),
    ] as StreamMessage[] });
    render(<ConversationStream />);
    const chips = [...document.querySelectorAll('[data-ledger-chip="14"]')];
    expect(chips).toHaveLength(2);
    for (const chip of chips) {
      expect(chip.textContent).toBe('N14 · Clean nights before live mode');
      expect(chip.getAttribute('title')).toBe('How many clean nights before live mode?');
    }
    expect(document.querySelector('[data-ledger-chip="12"]')!.textContent).toBe('N12 · Merge PR #62 into main?');
  });

  it('the chip index changes when a title changes', () => {
    const { result } = renderHook(() => useLedgerChips());
    const first = result.current;
    act(() => {
      useLedgerCard.setState({ byProject: { 'proj-1': { card: { ...TITLED, index: TITLED.index.map((e) => (e.seq === 12 ? { ...e, title: 'Merge PR #62' } : e)) }, loading: false, error: null, request: 2 } } });
    });
    expect(result.current).not.toBe(first);
    expect(result.current!.index.get(12)!.title).toBe('Merge PR #62');
  });
});

describe('titles on the card', () => {
  it('a full card: the title is the headline and the full question is below it', () => {
    render(<LedgerCard />);
    const card = fullCard(14);
    expect(within(card).getByTestId('ledger-headline')).toHaveTextContent(/^Clean nights before live mode$/);
    expect(within(card).getByTestId('ledger-question')).toHaveTextContent('How many clean nights before live mode?');
    expect(within(card).getByText('N14')).toBeInTheDocument();
    expect(within(card).getByText('Decide')).toBeInTheDocument();
  });

  it('a full card without a title looks as it does today: the question is the headline', () => {
    render(<LedgerCard />);
    const card = fullCard(12);
    expect(within(card).getByTestId('ledger-headline')).toHaveTextContent(/^Merge PR #62 into main\?$/);
    expect(within(card).queryByTestId('ledger-question')).toBeNull();
  });

  it('short rows show "N9 · title", with the question on hover; a row without a title keeps its question', () => {
    useLedgerFolds.setState({ open: { actions: true } });
    render(<LedgerCard />);
    const line = screen.getByRole('button', { name: /^N9 · Old tag check/ });
    expect(line.getAttribute('title')).toBe('Keep or drop the old tag check?');
    expect(screen.getByRole('button', { name: /^N20 · Check the staging banner/ })).toBeInTheDocument();
    const plain = screen.getByRole('button', { name: /^N21 · Rotate the test key\./ });
    expect(plain.getAttribute('title')).toBeNull();
  });
});

describe('the popover', () => {
  it('the title, the question, the status and the answer', () => {
    useLedgerCard.setState({ popover: { projectId: 'proj-1', seq: 40, x: 10, y: 10 } });
    render(<LedgerRefPopover />);
    const pop = screen.getByRole('dialog', { name: 'N40' });
    expect(within(pop).getByText('N40 · Staging bucket for the export')).toBeInTheDocument();
    expect(within(pop).getByText('Use the staging bucket for the export test?')).toBeInTheDocument();
    expect(within(pop).getByText('Answered')).toBeInTheDocument();
    expect(pop).toHaveTextContent('Answer: "yes, N40: A"');
  });

  it('without a title: the question as the heading, as today', () => {
    useLedgerCard.setState({ popover: { projectId: 'proj-1', seq: 2, x: 10, y: 10 } });
    render(<LedgerRefPopover />);
    const pop = screen.getByRole('dialog', { name: 'N2' });
    expect(within(pop).getByText('N2 · Rename the CLI?')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useLedgerCard.getState().popover).toBeNull();
  });
});
