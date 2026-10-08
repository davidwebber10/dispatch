// Clicks on the pinned card fill the message box (pinned card spec 2026-10-08, Unit 8): the store
// appends to the project's draft, the composer shows it with a hint and takes the focus, and
// nothing is sent until the user presses Enter.
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useOverseer } from './store';
import { useProjects } from '../../stores/projects';
import { useLedgerCard, useLedgerFolds } from '../../stores/ledgerCard';
import { Composer } from './components/Composer';
import { LedgerCard } from './components/LedgerCard';
import { FIXTURE } from './ledger-fixture';
import { api } from '../../api/client';

const box = () => screen.getByPlaceholderText(/directive/i) as HTMLTextAreaElement;
const fullCard = (seq: number) => document.querySelector(`[data-ledger-seq="${seq}"][data-full="true"]`) as HTMLElement;

beforeEach(() => {
  localStorage.clear();
  useOverseer.setState({ coordinatorId: 'coord-1', coordinatorProject: 'p1', composerImagesByProject: {}, draftHint: null, mobileTab: 'work' } as never);
  useProjects.setState({ activeId: 'p1' } as never);
  useLedgerCard.setState({ byProject: { p1: { card: FIXTURE, loading: false, error: null, request: 1 } } });
  useLedgerFolds.setState({ open: { actions: true } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('addToDraft', () => {
  it('appends to the project draft, sets the hint and switches mobile to the Stream tab', () => {
    useOverseer.getState().addToDraft('p1', 'N17: A');
    useOverseer.getState().addToDraft('p1', 'N34: approve');
    expect(localStorage.getItem('dispatch:draft:p1')).toBe('N17: A, N34: approve');
    expect(useOverseer.getState().draftHint).toMatchObject({ project: 'p1', text: 'N34: approve' });
    expect(useOverseer.getState().mobileTab).toBe('stream');
    // Another project's draft stays its own.
    expect(localStorage.getItem('dispatch:draft:p2')).toBeNull();
  });

  it('the composer is not mounted: it shows the draft when it mounts', () => {
    useOverseer.getState().addToDraft('p1', 'N17: A');
    render(<Composer />);
    expect(box().value).toBe('N17: A');
    expect(screen.getByText('Added N17: A. Press Enter to send, or keep adding.')).toBeInTheDocument();
  });
});

describe('the card and the composer', () => {
  it('option, Approve and Done clicks append to the draft without loss; the composer takes the focus; nothing is sent', () => {
    const send = vi.spyOn(api, 'sendStructuredMessage').mockResolvedValue(undefined as never);
    render(<><LedgerCard /><Composer /></>);
    fireEvent.change(box(), { target: { value: 'my own words' } });
    fireEvent.click(within(fullCard(14)).getByRole('button', { name: /^A\. 5 nights/ }));
    expect(box().value).toBe('my own words, N14: A');
    expect(document.activeElement).toBe(box());
    expect(screen.getByText('Added N14: A. Press Enter to send, or keep adding.')).toBeInTheDocument();
    fireEvent.click(within(fullCard(12)).getByRole('button', { name: /Approve/ }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Done' })[0]);
    expect(box().value).toBe('my own words, N14: A, N12: approve, N20: done');
    expect(screen.getByText('Added N20: done. Press Enter to send, or keep adding.')).toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
  });

  it('Enter sends the draft as the user\'s own message and clears the hint', () => {
    const send = vi.spyOn(api, 'sendStructuredMessage').mockResolvedValue(undefined as never);
    render(<Composer />);
    act(() => { useOverseer.getState().addToDraft('p1', 'N14: A'); });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(send).toHaveBeenCalledWith('coord-1', 'N14: A');
    expect(box().value).toBe('');
    expect(screen.queryByText(/Press Enter to send/)).not.toBeInTheDocument();
    expect(useOverseer.getState().draftHint).toBeNull();
  });

  it('the hint of another project never shows', () => {
    useOverseer.getState().addToDraft('p2', 'N3: B');
    render(<Composer />);
    expect(box().value).toBe('');
    expect(screen.queryByText(/Press Enter to send/)).not.toBeInTheDocument();
  });
});
