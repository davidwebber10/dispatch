// Regression test for the 💬 "direct message to an agent" coordinator notice
// (service.ts's noteUserMessageToAgent). It used to fall through detectAgencyNotice
// undetected and render as a raw "You" bubble — the full injected system text shown
// verbatim, as if the human had typed it. Stream.tsx's detectDirectMessageNotice +
// DirectMessageNoticeMsg now catch it and render a small card instead (see that file's
// "Direct-message notice" section for the design rationale).
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
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
  // ConversationStream now gates coordinator fields on activeId === coordinatorProject
  // (the cross-tab bleed fix) — tests must set the viewed project to match, or the
  // gating (correctly) blanks the stream as belonging to another project.
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

// Mirrors service.ts's noteUserMessageToAgent template exactly — the frontend detector
// (Stream.tsx's detectDirectMessageNotice) parses this shape.
const directMessageNoticeText = (message = 'Please add error logging.') =>
  `💬 The user just sent your agent "Bob" (mission "Fix auth") [agentId term-123] a message ` +
  `directly, not through you: "${message}". This may change what you asked it to do. Read how ` +
  `it responds with read_agent and adjust — don't assume it's still following your original instructions.`;

describe('ConversationStream — direct-message notice card', () => {
  it('renders agent name, mission, and the quoted message as a card, not a raw bubble', () => {
    useOverseer.setState({ coordinatorStream: [m('user', 'You', directMessageNoticeText(), '9:02', 0)] });
    render(<ConversationStream />);
    expect(screen.getByText('Direct message to "Bob"')).toBeInTheDocument();
    expect(screen.getByText('· Fix auth')).toBeInTheDocument();
    expect(screen.getByText('“Please add error logging.”')).toBeInTheDocument();
    expect(screen.getByText(/This may change what you asked it to do/)).toBeInTheDocument();
    // the raw agentId is never shown as visible text — only used for the click-through
    expect(screen.queryByText(/term-123/)).not.toBeInTheDocument();
  });

  it("quoted message extraction is not confused by quotes inside the user's own message", () => {
    useOverseer.setState({
      coordinatorStream: [m('user', 'You', directMessageNoticeText('please rename "foo" to "bar"'), '9:02', 0)],
    });
    render(<ConversationStream />);
    expect(screen.getByText('“please rename "foo" to "bar"”')).toBeInTheDocument();
  });

  it('opens the agent lightbox when the card is clicked', () => {
    const drillInto = vi.fn();
    useOverseer.setState({
      coordinatorStream: [m('user', 'You', directMessageNoticeText(), '9:02', 0)],
      drillInto,
    });
    const { container } = render(<ConversationStream />);
    // Queried via [title] rather than getByRole(..., {name}) — the button's accessible name is
    // computed from its visible text content (name/mission/quote/footer), not the title attr.
    fireEvent.click(container.querySelector('[title="Open this agent"]')!);
    expect(drillInto).toHaveBeenCalledWith('term-123');
  });
});
