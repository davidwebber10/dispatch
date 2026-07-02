import { render, screen, fireEvent } from '@testing-library/react';
import { test, expect, describe, it, beforeAll } from 'vitest';
import { MessageScroller } from '@shadcn/react/message-scroller';
import type { ConvItem } from '../../../api/types';
import { UserBubble, renderTimeline } from './ChatView';

test('a human-sent turn (untagged/legacy or explicit "user") renders as a plain bubble with no "via" label', () => {
  render(<UserBubble text="hi claude" />);
  expect(screen.getByText('hi claude')).toBeInTheDocument();
  expect(screen.queryByText(/^via /)).not.toBeInTheDocument();
});

test('an explicit source="user" turn also renders with no "via" label', () => {
  render(<UserBubble text="hi claude" source="user" />);
  expect(screen.getByText('hi claude')).toBeInTheDocument();
  expect(screen.queryByText(/^via /)).not.toBeInTheDocument();
});

test('a coordinator-relayed turn (source="coordinator") gets a "via {coordinator name}" label', () => {
  render(<UserBubble text="do the thing" source="coordinator" />);
  expect(screen.getByText('do the thing')).toBeInTheDocument();
  // Default coordinatorName is '' → useDispatchName falls back to "Control Plane".
  expect(screen.getByText(/via Control Plane/)).toBeInTheDocument();
});

// jsdom lacks the observers the MessageScroller primitive touches (mirrors Stream.test.tsx).
beforeAll(() => {
  class Noop { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Noop;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Noop;
});

function renderTimelineItems(items: ConvItem[]) {
  return render(
    <MessageScroller.Provider>
      <MessageScroller.Root>
        <MessageScroller.Viewport>
          <MessageScroller.Content>
            {renderTimeline(items, () => {}, new Set())}
          </MessageScroller.Content>
        </MessageScroller.Viewport>
      </MessageScroller.Root>
    </MessageScroller.Provider>,
  );
}

// Regression coverage for the reported bug: a subagent's answered AskUserQuestion used to
// vanish from the chat entirely once answered — renderTimeline unconditionally `continue`d
// past ANY item named 'AskUserQuestion' (live or answered alike), relying solely on the
// interactive <AskQuestionCard> overlay (ChatView's `pending` prop) to ever show it, which
// unmounts the instant it's answered. Now an answered pair renders a durable, collapsed record.
describe('renderTimeline — answered AskUserQuestion stays in history (regression)', () => {
  const items: ConvItem[] = [
    { kind: 'tool', toolId: 'tu-1', toolName: 'AskUserQuestion', toolInput: JSON.stringify({ questions: [{ question: 'Ready to ship?', header: 'Release', options: ['Yes', 'No'] }] }) },
    { kind: 'tool-result', toolId: 'tu-1', text: 'Your questions have been answered: "Ready to ship?"="Yes". You can now continue with these answers in mind.' },
  ];

  it('shows a collapsed "Q → A" summary instead of nothing', () => {
    renderTimelineItems(items);
    expect(screen.getByText(/Ready to ship\?/)).toBeInTheDocument();
    expect(screen.getByText(/Yes/)).toBeInTheDocument();
    expect(screen.queryByText('No')).not.toBeInTheDocument(); // collapsed: options aren't shown yet
  });

  it('expanding it reveals the full question, every option, and which one was picked', () => {
    renderTimelineItems(items);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Release')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument(); // the unpicked option, now visible
  });

  it('renders nothing while genuinely still pending (no tool_result yet) — the live overlay covers it', () => {
    const pendingOnly: ConvItem[] = [
      { kind: 'tool', toolId: 'tu-2', toolName: 'AskUserQuestion', toolInput: JSON.stringify({ questions: [{ question: 'Which env?', options: ['staging', 'prod'] }] }) },
    ];
    renderTimelineItems(pendingOnly);
    expect(screen.queryByText('Which env?')).not.toBeInTheDocument();
  });

  it('pairs tool_use ↔ tool_result via array adjacency too (older REST-paged history has no toolId)', () => {
    const noToolId: ConvItem[] = [
      { kind: 'tool', toolName: 'AskUserQuestion', toolInput: JSON.stringify({ questions: [{ question: 'Cut the release?', options: ['Yes', 'No'] }] }) },
      { kind: 'tool-result', text: 'Your questions have been answered: "Cut the release?"="Yes". You can now continue with these answers in mind.' },
    ];
    renderTimelineItems(noToolId);
    expect(screen.getByText(/Cut the release\?/)).toBeInTheDocument();
  });
});
