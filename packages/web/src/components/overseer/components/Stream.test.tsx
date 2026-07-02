// Regression test for the "Open Dispatch chat freezes with no visible question" bug:
// when the COORDINATOR itself calls AskUserQuestion, its CLI blocks on stdin until answered.
// That pending is NOT a Need (isStructuredWorker excludes coordinators) and useNeedsSync never
// fetches it — so the ConversationStream MUST surface it inline (mirroring the agent ChatView),
// or the chat silently stops responding. These tests assert that inline surface + its wiring.
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { ConvItem, PendingPermission } from '../../../api/types';
import { useOverseer } from '../store';
import { m } from '../data';
import { convItemsToStream } from '../live';
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

// Regression test for the actual reported bug: answering the coordinator's own AskUserQuestion
// used to make it disappear from the conversation entirely — clearing coordinatorPending
// unmounts the live <AskQuestionCard> above, and (before this fix) nothing in coordinatorStream
// ever took its place, since convItemsToStream silently dropped AskUserQuestion tool_use/
// tool_result pairs. This reproduces the POST-answer state (pending cleared, the durable
// tool_result now folded into the stream via convItemsToStream) and asserts the question stays
// visible as a collapsed record instead of vanishing.
describe('ConversationStream — answered AskUserQuestion stays visible (regression)', () => {
  it('shows a collapsed summary once the pending question resolves, instead of nothing', () => {
    const items: ConvItem[] = [
      {
        kind: 'tool', toolId: 'tu-1', toolName: 'AskUserQuestion',
        toolInput: JSON.stringify({ questions: [{ question: 'Have you finished logging in to Salsify?', header: 'Salsify login', options: ['Yes, logged in', 'Not yet'] }] }),
      },
      { kind: 'tool-result', toolId: 'tu-1', text: 'Your questions have been answered: "Have you finished logging in to Salsify?"="Yes, logged in". You can now continue with these answers in mind.' },
    ];
    useOverseer.setState({ coordinatorPending: null, coordinatorStream: convItemsToStream(items) });
    render(<ConversationStream />);
    // The interactive live card (with its clickable options) is gone...
    expect(screen.queryByRole('button', { name: /Yes, logged in/ })).not.toBeInTheDocument();
    // ...but the question itself is still visible — collapsed, with its answer — not vanished.
    expect(screen.getByText(/Have you finished logging in to Salsify\?/)).toBeInTheDocument();
    expect(screen.getByText(/Yes, logged in/)).toBeInTheDocument();
  });

  it('expanding the collapsed record reveals the full question, options, and the one chosen', () => {
    const items: ConvItem[] = [
      { kind: 'tool', toolId: 'tu-2', toolName: 'AskUserQuestion', toolInput: JSON.stringify({ questions: [{ question: 'Deploy to prod?', options: ['Yes', 'No'] }] }) },
      { kind: 'tool-result', toolId: 'tu-2', text: 'Your questions have been answered: "Deploy to prod?"="Yes". You can now continue with these answers in mind.' },
    ];
    useOverseer.setState({ coordinatorPending: null, coordinatorStream: convItemsToStream(items) });
    render(<ConversationStream />);
    // "No" (the unselected option) only shows once the record is expanded.
    expect(screen.queryByText('No')).not.toBeInTheDocument();
    // `hidden: true`: with no question pending, ConversationStream's paint gate keeps the
    // scroller `visibility: hidden` until a real IntersectionObserver settles it — which jsdom
    // never fires — so the (very much present) toggle button is accessibility-hidden here.
    fireEvent.click(screen.getByRole('button', { hidden: true }));
    expect(screen.getByText('No')).toBeInTheDocument();
  });

  it('still shows nothing while the question is genuinely still pending (no tool_result yet)', () => {
    const items: ConvItem[] = [
      { kind: 'tool', toolId: 'tu-3', toolName: 'AskUserQuestion', toolInput: JSON.stringify({ questions: [{ question: 'Which env?', options: ['staging', 'prod'] }] }) },
    ];
    useOverseer.setState({ coordinatorPending: null, coordinatorStream: convItemsToStream(items) });
    render(<ConversationStream />);
    expect(screen.queryByText('Which env?')).not.toBeInTheDocument();
  });
});

// Regression test: the coordinator's own stream used to render a "Control Plane" name label
// above every message, which is redundant — every turn in this view is inherently the
// coordinator's own. The label was removed (only the timestamp header remains); this locks
// that in without touching the agent ChatView's UserBubble "via {name}" badge, which stays
// (it distinguishes a coordinator-relayed message from a human's own direct one).
describe('ConversationStream — coordinator message header', () => {
  it('renders the message body without a redundant coordinator name label', () => {
    useOverseer.setState({
      coordinatorStream: [m('overseer', 'Control Plane', 'Stage deploy failed and rolled back cleanly.', '9:02', 1)],
    });
    render(<ConversationStream />);
    expect(screen.getByText('Stage deploy failed and rolled back cleanly.')).toBeInTheDocument();
    expect(screen.queryByText('Control Plane')).not.toBeInTheDocument();
  });
});
