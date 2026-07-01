// Regression test for the "Open Dispatch chat freezes with no visible question" bug:
// when the COORDINATOR itself calls AskUserQuestion, its CLI blocks on stdin until answered.
// That pending is NOT a Need (isStructuredWorker excludes coordinators) and useNeedsSync never
// fetches it — so the ConversationStream MUST surface it inline (mirroring the agent ChatView),
// or the chat silently stops responding. These tests assert that inline surface + its wiring.
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { PendingPermission } from '../../../api/types';
import { useOverseer } from '../store';
import { ConversationStream } from './Stream';

// jsdom lacks the observers + scroll APIs the MessageScroller primitive touches.
beforeAll(() => {
  class Noop { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Noop;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Noop;
  Element.prototype.scrollTo = Element.prototype.scrollTo || (() => {});
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
});

beforeEach(() => {
  useOverseer.setState({
    coordinatorId: 'coord-1',
    coordinatorProject: 'proj-1',
    coordinatorStream: [],
    coordinatorBusy: false,
    coordinatorPending: null,
    coordinatorAnswer: () => {},
  });
});

afterEach(cleanup);

const askPending = (): PendingPermission => ({
  requestId: 'req-1',
  toolName: 'AskUserQuestion',
  input: {},
  questions: [
    { question: 'Have you finished logging in to Salsify?', header: 'Salsify login', options: ['Yes, logged in', 'Not yet'], multiSelect: false },
  ],
});

describe('ConversationStream — coordinator AskUserQuestion surfaced inline', () => {
  it('renders the coordinator\'s pending question with its options', () => {
    useOverseer.setState({ coordinatorPending: askPending() });
    render(<ConversationStream />);
    expect(screen.getByText('Have you finished logging in to Salsify?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Yes, logged in/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Not yet/ })).toBeInTheDocument();
  });

  it('answering an option calls the coordinator\'s answer() (unblocks the CLI)', () => {
    const answer = vi.fn();
    useOverseer.setState({ coordinatorPending: askPending(), coordinatorAnswer: answer });
    render(<ConversationStream />);
    fireEvent.click(screen.getByRole('button', { name: /Yes, logged in/ }));
    expect(answer).toHaveBeenCalledWith({ 'Have you finished logging in to Salsify?': 'Yes, logged in' });
  });

  it('renders no question card when nothing is pending', () => {
    render(<ConversationStream />);
    expect(screen.queryByText('Have you finished logging in to Salsify?')).not.toBeInTheDocument();
  });
});
