// Every daemon notice to the overseer renders as a muted system pill (or the 💬 card), never as a
// raw "You" bubble — including the Batch block the daemon appends to the five agent notices.
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { m } from '../data';
import { useOverseer } from '../store';
import { useProjects } from '../../../stores/projects';
import { ConversationStream } from './Stream';

beforeAll(() => {
  class Noop { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Noop;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Noop;
  Element.prototype.scrollTo = Element.prototype.scrollTo || (() => {});
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
});

beforeEach(() => {
  useProjects.setState({ activeId: 'proj-1' });
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

const BATCH =
  '\n\nBatch: still working — 1 agent ("Review Y").\n' +
  'Do not post a recap. If this needs a decision, add it with ledger_add\n' +
  'and post only that item. Otherwise write at most one line.\n' +
  'Open ledger items: N3.';

// Mirrors the templates in packages/core/src/sessions/service.ts and sessions/interim-recap.ts.
const NOTICES: Array<[string, string, string]> = [
  ['finished', '✅ Your agent "Bob" (mission "Fix auth") [agentId term-1] just finished a turn.\nIts latest output: done\n\nRead its full work with read_agent({ agentId: "term-1" }), then decide the next step.' + BATCH, 'Agent "Bob" finished'],
  ['blocked', '⏸️ Your agent "Bob" (mission "Fix auth") [agentId term-1] is BLOCKED, waiting on you — it stopped its turn to ask:\n"Which branch?"\n\nIt cannot proceed until you reply.' + BATCH, 'Agent "Bob" is blocked, waiting on you'],
  ['question', '🔔 Your agent "Bob" (mission "Fix auth") is PAUSED waiting on you to answer a question (it cannot proceed until you do):\n  • [Fix] Stage the fix?\n\nanswer_agent({ agentId: "term-1", answers: { "Fix": "<chosen option>" } })' + BATCH, 'Agent "Bob" needs an answer'],
  ['stopped', '⚠️ The user just stopped your agent "Bob" (mission "Fix auth") [agentId term-1] while it was working. Do not silently ignore this.' + BATCH, 'You stopped agent "Bob"'],
  ['interim', '🕒 Interim recap due: 2 new items wait on the user, and 2 agents\nstill work. Post the short recap now and mark it "interim". Then keep holding.', 'Interim recap due'],
];

describe('ConversationStream — agency notices with the Batch block', () => {
  for (const [kind, text, summary] of NOTICES) {
    it(`${kind}: renders the one-line pill, not a raw bubble`, () => {
      useOverseer.setState({ coordinatorStream: [m('user', 'You', text, '9:02', 0)] });
      render(<ConversationStream />);
      expect(screen.getByText(summary)).toBeInTheDocument();
      expect(screen.queryByText(/Batch:/)).not.toBeInTheDocument();
      expect(screen.queryByText('You')).not.toBeInTheDocument();
    });
  }

  it('direct message: still the card, with the Batch block appended', () => {
    const text = '💬 The user just sent your agent "Bob" (mission "Fix auth") [agentId term-1] a message directly, not through you: "use staging". This may change what you asked it to do. Read how it responds with read_agent and adjust.' + BATCH;
    useOverseer.setState({ coordinatorStream: [m('user', 'You', text, '9:02', 0)] });
    render(<ConversationStream />);
    expect(screen.getByText('Direct message to "Bob"')).toBeInTheDocument();
    expect(screen.getByText('“use staging”')).toBeInTheDocument();
  });

  it('a real user message that starts with one of the emoji stays a "You" bubble', () => {
    useOverseer.setState({ coordinatorStream: [m('user', 'You', '⏸️ pause the deploy for now', '9:02', 0)] });
    render(<ConversationStream />);
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('⏸️ pause the deploy for now')).toBeInTheDocument();
  });
});
