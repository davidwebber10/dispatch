import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { StatusNotice, DismissableStatusNotice } from './StatusNotice';
import { useDismissedNotices } from '../../../stores/dismissedNotices';

const j = (o: unknown) => JSON.stringify(o);

describe('<StatusNotice>', () => {
  it('surfaces a needs_you question (the buried "waiting on your feedback" case)', () => {
    render(<StatusNotice input={j({ state: 'needs_you', summary: 'Found 3 candidates', ask: 'Which auth flow — OAuth or PAT?' })} />);
    expect(screen.getByTestId('status-notice')).toBeTruthy();
    expect(screen.getByText('NEEDS YOU')).toBeTruthy();
    expect(screen.getByText('Which auth flow — OAuth or PAT?')).toBeTruthy(); // the question, verbatim
    expect(screen.getByText('Found 3 candidates')).toBeTruthy();              // the findings/summary too
  });

  it('surfaces a blocked blocker', () => {
    render(<StatusNotice input={j({ state: 'blocked', blocker: 'waiting on the deploy' })} />);
    expect(screen.getByText('BLOCKED')).toBeTruthy();
    expect(screen.getByText('waiting on the deploy')).toBeTruthy();
  });

  it('renders a done turn as a labeled Done card', () => {
    render(<StatusNotice input={j({ state: 'done', summary: 'shipped v2.9.0' })} />);
    expect(screen.getByTestId('status-notice')).toBeTruthy();
    expect(screen.getByText(/done/i)).toBeTruthy();
    expect(screen.getByText('shipped v2.9.0')).toBeTruthy();
    expect(screen.queryByText(/waiting on you/i)).toBeNull();
  });

  it('labels an unknown state with the raw state name instead of borrowing Done', () => {
    render(<StatusNotice input={j({ state: 'paused', summary: 'holding until CI finishes' })} />);
    expect(screen.getByText(/paused/i)).toBeTruthy();
    expect(screen.getByText('holding until CI finishes')).toBeTruthy();
    expect(screen.queryByText(/done/i)).toBeNull();
  });

  it('does not duplicate the summary when it equals the primary line', () => {
    // needs_you with only a summary (no ask): the summary IS the primary line, shown once.
    render(<StatusNotice input={j({ state: 'needs_you', summary: 'Should I proceed?' })} />);
    expect(screen.getAllByText('Should I proceed?')).toHaveLength(1);
  });

  it('renders nothing for a done turn with no summary, or for malformed input', () => {
    const { container: c1 } = render(<StatusNotice input={j({ state: 'done' })} />);
    expect(c1.firstChild).toBeNull();
    const { container: c2 } = render(<StatusNotice input="not json {" />);
    expect(c2.firstChild).toBeNull();
    const { container: c3 } = render(<StatusNotice input={undefined} />);
    expect(c3.firstChild).toBeNull();
  });
});

describe('<StatusNotice> dismiss ×', () => {
  it('shows no × without onDismiss (the stateless card)', () => {
    render(<StatusNotice input={j({ state: 'done', summary: 'shipped' })} />);
    expect(screen.queryByTestId('status-notice-dismiss')).toBeNull();
  });

  it('calls onDismiss when the × is clicked', () => {
    const onDismiss = vi.fn();
    render(<StatusNotice input={j({ state: 'blocked', blocker: 'CI' })} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide this status' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('<DismissableStatusNotice>', () => {
  beforeEach(() => { localStorage.clear(); useDismissedNotices.setState({ keys: [] }); });

  it('hides the card on ×, remembers it per scope, and leaves the same card in another scope', () => {
    const input = j({ state: 'done', summary: 'shipped v2.9.0' });
    render(<DismissableStatusNotice scope="thread-a" input={input} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide this status' }));
    expect(screen.queryByTestId('status-notice')).toBeNull();
    cleanup();
    // A remount (refresh) keeps it hidden...
    render(<DismissableStatusNotice scope="thread-a" input={input} />);
    expect(screen.queryByTestId('status-notice')).toBeNull();
    cleanup();
    // ...while an identically worded card in another thread still shows.
    render(<DismissableStatusNotice scope="thread-b" input={input} />);
    expect(screen.getByTestId('status-notice')).toBeTruthy();
  });

  it('keys by content, so the live (compact, with id) and paged (pretty JSON) shapes agree', () => {
    const live = JSON.stringify({ state: 'done', summary: 'shipped' });
    const paged = JSON.stringify({ summary: 'shipped', state: 'done' }, null, 2);
    render(<DismissableStatusNotice scope="t" input={live} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide this status' }));
    cleanup();
    render(<DismissableStatusNotice scope="t" input={paged} />);
    expect(screen.queryByTestId('status-notice')).toBeNull();
  });
});
