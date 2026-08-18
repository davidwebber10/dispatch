import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThreadAskBanner } from './ThreadAskBanner';
import { useThreadStatus } from '../../stores/threadStatus';
import { useTabs } from '../../stores/tabs';

const ID = 'term-1';

function seedTab(status: string, config: Record<string, unknown>) {
  useTabs.setState({ byProject: { p1: [{ id: ID, sessionId: 'p1', label: 'x', status, type: 'claude-code', config } as any] } });
}

beforeEach(() => {
  useThreadStatus.setState({ byTerminal: {} });
  useTabs.setState({ byProject: {} });
});

describe('<ThreadAskBanner>', () => {
  it('surfaces a live declared ask, with the Answer shortcut', () => {
    useThreadStatus.setState({ byTerminal: { [ID]: { threadStatus: 'needs_input', activity: 'Which auth flow — OAuth or PAT?' } } });
    seedTab('needs_input', { transport: 'structured' });
    const onAnswer = vi.fn();
    render(<ThreadAskBanner terminalId={ID} onAnswer={onAnswer} />);

    expect(screen.getByTestId('thread-ask-banner')).toBeTruthy();
    expect(screen.getByText(/this thread is asking you/i)).toBeTruthy();
    expect(screen.getByText('Which auth flow — OAuth or PAT?')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /answer/i }));
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it('surfaces a declared ask from the persisted row when no live status has arrived yet', () => {
    // No byTerminal entry — the fresh-load / reconnect case.
    seedTab('needs_input', { lastOutcome: { summary: 'Confirm dropping orders_v1?', needsHelp: true, inferred: false } });
    render(<ThreadAskBanner terminalId={ID} />);
    expect(screen.getByText('Confirm dropping orders_v1?')).toBeTruthy();
  });

  it('renders nothing when the thread is working (the anti-stale case)', () => {
    useThreadStatus.setState({ byTerminal: { [ID]: { threadStatus: 'working', activity: 'Editing files' } } });
    // Persisted row still says needs_input with a declared ask — live must win.
    seedTab('needs_input', { lastOutcome: { summary: 'old question', needsHelp: true, inferred: false } });
    const { container } = render(<ThreadAskBanner terminalId={ID} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('thread-ask-banner')).toBeNull();
  });

  it('renders nothing for an inferred ask (already visible in the transcript)', () => {
    useThreadStatus.setState({ byTerminal: { [ID]: { threadStatus: 'needs_input', activity: 'Asked a question' } } });
    seedTab('needs_input', { lastOutcome: { summary: 'Should I proceed?', needsHelp: true, inferred: true } });
    expect(screen.queryByTestId('thread-ask-banner')).toBeNull();
  });

  it('shows the ask without an Answer button when no onAnswer is provided', () => {
    useThreadStatus.setState({ byTerminal: { [ID]: { threadStatus: 'needs_input', activity: 'Ship it?' } } });
    seedTab('needs_input', {});
    render(<ThreadAskBanner terminalId={ID} />);
    expect(screen.getByText('Ship it?')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /answer/i })).toBeNull();
  });
});
