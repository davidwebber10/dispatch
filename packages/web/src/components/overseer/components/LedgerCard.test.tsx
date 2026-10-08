// The pinned decision card (pinned card spec 2026-10-08, Unit 7), drawn from a fixture in the shape
// of real ledger rows.
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LedgerCard } from './LedgerCard';
import { useLedgerCard, useLedgerFolds, LEDGER_FOLDS_KEY } from '../../../stores/ledgerCard';
import { useProjects } from '../../../stores/projects';
import { FIXTURE, EMPTY_CARD, NOW } from '../ledger-fixture';
import type { LedgerCard as Card } from '../../../api/types';

function show(card: Card | null, extra: { error?: string | null; loading?: boolean } = {}) {
  useLedgerCard.setState({ byProject: { p1: { card, loading: extra.loading ?? false, error: extra.error ?? null, request: 1 } } });
}
const fullCard = (seq: number) => document.querySelector(`[data-ledger-seq="${seq}"][data-full="true"]`) as HTMLElement | null;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  localStorage.clear();
  useLedgerFolds.setState({ open: {} });
  useProjects.setState({ activeId: 'p1' } as never);
  show(FIXTURE);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('LedgerCard — the sections', () => {
  it('the header: "Needs you", the counts, the time of the last update, and the folded rules line', () => {
    render(<LedgerCard />);
    const header = screen.getByTestId('ledger-card-header');
    expect(header).toHaveTextContent('Needs you');
    expect(header).toHaveTextContent('3 decisions · 2 actions');
    expect(header).toHaveTextContent(/updated \S+/);
    expect(screen.getByRole('button', { name: /Project rules: 1 in force/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('never deploy on Fridays')).not.toBeInTheDocument();
  });

  it('Needs you now: full cards for the cards, one line for the rest', () => {
    render(<LedgerCard />);
    expect(fullCard(14)).not.toBeNull();
    expect(fullCard(12)).not.toBeNull();
    expect(fullCard(9)).toBeNull();
    const line = screen.getByRole('button', { name: /N9 · Keep or drop the old tag check\?/ });
    expect(line).toHaveTextContent('Rec: B. drop');
  });

  it('a click on a line opens it as a full card', () => {
    render(<LedgerCard />);
    fireEvent.click(screen.getByRole('button', { name: /N9 · Keep or drop the old tag check\?/ }));
    expect(fullCard(9)).not.toBeNull();
    expect(within(fullCard(9)!).getByText('One check less per run.')).toBeInTheDocument();
  });

  it('the other sections fold to a count', () => {
    render(<LedgerCard />);
    for (const [name, count] of [['Your tests and actions', 2], ['Running on defaults', 1], ['Decided since the last recap', 3], ['Not yet triaged', 1], ['Parked', 1]] as const) {
      const toggle = screen.getByRole('button', { name: new RegExp(`^${name} ${count}$`) });
      expect(toggle, name).toHaveAttribute('aria-expanded', 'false');
    }
    expect(screen.queryByText(/Check the banner on staging\./)).not.toBeInTheDocument();
    expect(screen.queryByText(/Rename the CLI\?/)).not.toBeInTheDocument();
  });
});

describe('LedgerCard — a full card', () => {
  it('number and kind, NEW, the age, the question, the context cut with "more", the options as rows, why, the default, what it holds up, the source and the note', () => {
    render(<LedgerCard />);
    const card = within(fullCard(14)!);
    expect(card.getByText('N14')).toBeInTheDocument();
    expect(card.getByText('Decide')).toBeInTheDocument();
    expect(card.getByText('NEW')).toBeInTheDocument();
    expect(card.getByText('open 1h')).toBeInTheDocument();
    expect(card.getByText('How many clean nights before live mode?')).toBeInTheDocument();
    // The context is cut after about three lines; "more" shows the rest.
    const more = card.getByRole('button', { name: 'more' });
    expect(card.getByTestId('ledger-context')).toHaveAttribute('data-clamped', 'true');
    fireEvent.click(more);
    expect(card.getByTestId('ledger-context')).toHaveAttribute('data-clamped', 'false');
    expect(card.getByRole('button', { name: 'less' })).toBeInTheDocument();
    // Options as stacked rows: the label, then the effect; the recommended row is marked.
    const rows = card.getAllByRole('button', { name: /^[AB]\. / });
    expect(rows.map((r) => r.textContent)).toEqual([
      'A. 5 nightsRecommendedLive mode on Oct 14 at the earliest. Covers one weekend.',
      'B. 10 nightsOct 19. Covers two weekends.',
    ]);
    expect(rows[0]).toHaveAttribute('data-recommended', 'true');
    expect(card.getByText('Why A. 5 nights:')).toBeInTheDocument();
    expect(card.getByText('The weekend pattern is the known risk; 5 nights cover one weekend.')).toBeInTheDocument();
    expect(card.getByText('If you do not answer:')).toBeInTheDocument();
    expect(card.getByText('Holds up:')).toBeInTheDocument();
    expect(card.getByText('plan · docs/plans/readiness.md › Owner decisions · LR-6 · from agent "Readiness planner"')).toBeInTheDocument();
    expect(card.getByText('The planner did not know about the holiday freeze.')).toBeInTheDocument();
  });

  it('a go card has one Approve row and no NEW badge when it is not new', () => {
    render(<LedgerCard />);
    const card = within(fullCard(12)!);
    expect(card.getByText('Go')).toBeInTheDocument();
    expect(card.queryByText('NEW')).not.toBeInTheDocument();
    expect(card.getAllByRole('button', { name: /Approve/ })).toHaveLength(1);
    expect(card.getByText('PR #62')).toBeInTheDocument();
  });

  it('option, Approve and Done clicks hand their answer text to onAnswer; nothing is sent', () => {
    const onAnswer = vi.fn();
    render(<LedgerCard onAnswer={onAnswer} />);
    fireEvent.click(within(fullCard(14)!).getByRole('button', { name: /^B\. 10 nights/ }));
    fireEvent.click(within(fullCard(12)!).getByRole('button', { name: /Approve/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Your tests and actions/ }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Done' })[0]);
    expect(onAnswer.mock.calls).toEqual([['N14: B'], ['N12: approve'], ['N20: done']]);
  });
});

// Review round 1.
describe('LedgerCard — an expanded card keeps its action, and shows the overseer\'s reason', () => {
  it('an open do item opened as a full card keeps its Done control', () => {
    const onAnswer = vi.fn();
    useLedgerFolds.setState({ open: { actions: true } });
    render(<LedgerCard onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: /N20 · Check the banner on staging\./ }));
    const card = within(fullCard(20)!);
    fireEvent.click(card.getByRole('button', { name: 'Done' }));
    expect(onAnswer.mock.calls).toEqual([['N20: done']]);
  });

  it('a card decided by the overseer shows its choice with its own reason, apart from the original why', () => {
    useLedgerCard.setState({ byProject: { p1: { card: { ...FIXTURE, sections: { ...FIXTURE.sections, decidedSince: [{
      ...FIXTURE.sections.decidedSince[2], why: 'The agent preferred the new helper.', recommendation: 'B. new helper',
    }] } }, loading: false, error: null, request: 1 } } });
    useLedgerFolds.setState({ open: { decidedSince: true } });
    render(<LedgerCard />);
    fireEvent.click(screen.getByRole('button', { name: /N4 · Which retry helper\?/ }));
    const card = within(fullCard(4)!);
    expect(card.getByText('Why B. new helper:')).toBeInTheDocument();
    expect(card.getByText('Decided by overseer: the existing one. Reason: it covers this case')).toBeInTheDocument();
  });
});

describe('LedgerCard — folding', () => {
  it('a section opens on click, and its fold state is kept in local storage', () => {
    const { unmount } = render(<LedgerCard />);
    fireEvent.click(screen.getByRole('button', { name: /^Your tests and actions 2$/ }));
    expect(screen.getByText('N20 · Check the banner on staging.')).toBeInTheDocument();
    expect(screen.getByText('imported')).toBeInTheDocument(); // N21 came from the import
    expect(screen.getAllByRole('button', { name: 'Done' })).toHaveLength(2);
    expect(JSON.parse(localStorage.getItem(LEDGER_FOLDS_KEY)!)).toEqual({ actions: true });
    unmount();
    render(<LedgerCard />);
    expect(screen.getByRole('button', { name: /^Your tests and actions 2$/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('the decided, untriaged and parked rows say what happened', () => {
    useLedgerFolds.setState({ open: { decidedSince: true, untriaged: true, parked: true, onDefaults: true } });
    render(<LedgerCard />);
    expect(screen.getByText(/N3 · Use library A\?/).closest('button')).toHaveTextContent('Your answer: "N3: A"');
    expect(screen.getByText(/N8 · Drop the old flag\./).closest('button')).toHaveTextContent('Withdrawn: moot');
    expect(screen.getByText(/N4 · Which retry helper\?/).closest('button')).toHaveTextContent('Decided by overseer: the existing one');
    expect(screen.getByText(/N30 · Which day does the switch happen\?/).closest('button')).toHaveTextContent('from "Readiness planner"');
    expect(screen.getByText(/N2 · Rename the CLI\?/).closest('button')).toHaveTextContent('Parked: "later"');
    expect(screen.getByText(/N5 · Abort the import/).closest('button')).toHaveTextContent('Running on the default "abort above 1%"');
  });

  it('the rules line opens a read-only list', () => {
    render(<LedgerCard />);
    fireEvent.click(screen.getByRole('button', { name: /Project rules: 1 in force/ }));
    expect(screen.getByText(/N1 · "never deploy on Fridays"/)).toBeInTheDocument();
  });
});

describe('LedgerCard — empty and failed', () => {
  it('an empty ledger says "Nothing needs you."', () => {
    show(EMPTY_CARD);
    render(<LedgerCard />);
    expect(screen.getByText('Nothing needs you.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Your tests and actions/ })).not.toBeInTheDocument();
  });

  it('a load error with no card: "Could not load the decisions" and Retry loads again', () => {
    show(null, { error: 'GET failed: 502' });
    const load = vi.spyOn(useLedgerCard.getState(), 'load').mockResolvedValue();
    render(<LedgerCard />);
    expect(screen.getByText('Could not load the decisions')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(load).toHaveBeenCalledWith('p1');
  });

  it('a load error keeps the last card on screen', () => {
    show(FIXTURE, { error: 'GET failed: 502' });
    render(<LedgerCard />);
    expect(screen.getByText('Could not load the decisions')).toBeInTheDocument();
    expect(fullCard(14)).not.toBeNull();
  });
});

// Review round 1: what the user opened belongs to one project.
describe('LedgerCard — a project switch', () => {
  it('opened lines and "more" reset when the shown project changes', () => {
    useLedgerCard.setState({ byProject: {
      p1: { card: FIXTURE, loading: false, error: null, request: 1 },
      p2: { card: FIXTURE, loading: false, error: null, request: 1 },
    } });
    render(<LedgerCard />);
    fireEvent.click(screen.getByRole('button', { name: /N9 · Keep or drop the old tag check\?/ }));
    fireEvent.click(within(fullCard(14)!).getByRole('button', { name: 'more' }));
    expect(fullCard(9)).not.toBeNull();
    act(() => { useProjects.setState({ activeId: 'p2' } as never); });
    expect(fullCard(9)).toBeNull();
    expect(within(fullCard(14)!).getByTestId('ledger-context')).toHaveAttribute('data-clamped', 'true');
  });
});
