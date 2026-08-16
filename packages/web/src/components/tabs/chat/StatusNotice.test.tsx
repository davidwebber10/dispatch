import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusNotice } from './StatusNotice';

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
